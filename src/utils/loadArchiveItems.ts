/**
 * Loads the BKC archive into the `archive-items` Chroma collection, indexed by archive item:
 *
 *  - collection/json/youtube.json + collection/txt/youtube/<id>.txt  -> kind "youtube-transcript"
 *  - raw/archive.json items with body text in `content`              -> kind "fulltext"
 *  - raw/archive.json items without body text                        -> kind "bookmark"
 *                                                                       (compact title/description/provenance doc)
 *
 * Idempotent: items whose sourceId is already present in the collection are skipped.
 *
 * USAGE:
 *   NODE_ENV=development node --loader ts-node/esm src/utils/loadArchiveItems.ts [archivePath] [--limit=N] [--clean]
 *
 * archivePath defaults to config.archivePath (ARCHIVE_PATH env var).
 */
/* eslint-disable no-console */

import fs from 'fs'
import path from 'path'
import config from '../config/config.js'
import rag from '../agents/helpers/rag.js'
import {
  ARCHIVE_COLLECTION,
  ARCHIVE_COLLECTION_ID,
  getArchiveJsonIndex,
  getYoutubeIndex,
  getYoutubeTranscript,
  stripHtml
} from '../agents/tools/archive.js'

// Batch by estimated chunk count, not item count: one 100KB transcript becomes ~140
// chunks, and Chroma's HTTP endpoint drops the connection on very large addDocuments
// payloads. Keep each request comfortably small.
const MAX_CHUNKS_PER_BATCH = 150
const CHUNK_SIZE_ESTIMATE = 800 // chunkSize 1000 minus overlap 200

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const limitArg = process.argv.find((a) => a.startsWith('--limit='))
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity
const CLEAN = process.argv.includes('--clean')

const archivePath = path.resolve(positional[0] || config.archivePath || '')
if (!archivePath || !fs.existsSync(archivePath)) {
  throw new Error(`Archive path not found: "${archivePath}". Pass it as an argument or set ARCHIVE_PATH in .env.`)
}

interface ArchiveDoc {
  text: string
  metadata: Record<string, string>
}

function itemMetadata(
  sourceId: string,
  kind: string,
  item: { title?: unknown; url?: unknown; date_published?: unknown }
): Record<string, string> {
  const url = String(item.url || '')
  let source = ''
  try {
    source = url ? new URL(url).hostname.replace(/^www\./, '') : ''
  } catch {
    source = ''
  }
  return {
    sourceId,
    kind,
    collectionId: ARCHIVE_COLLECTION_ID,
    archiveType: 'item',
    // conversationName keeps citation labels compatible with the historian's transcript tools
    conversationName: String(item.title || sourceId),
    title: String(item.title || ''),
    url,
    source,
    date: String(item.date_published || '').slice(0, 10)
  }
}

function buildDocs(): ArchiveDoc[] {
  const docs: ArchiveDoc[] = []

  const youtube = getYoutubeIndex(archivePath)
  for (const [id, item] of youtube) {
    const transcript = getYoutubeTranscript(archivePath, id)
    const header = `${item.title}\n${stripHtml(String(item.description || ''))}`
    if (!transcript) {
      console.warn(`  no transcript for ${id} — indexing metadata only`)
    }
    docs.push({
      text: transcript ? `${header}\n\n${transcript}` : header,
      metadata: itemMetadata(id, 'youtube-transcript', item)
    })
  }

  for (const [id, item] of getArchiveJsonIndex(archivePath)) {
    const content = stripHtml(String(item.content || ''))
    const description = stripHtml(String(item.description || ''))
    const tags = ((item.tags as string[]) || []).join(', ')
    if (content) {
      docs.push({
        text: `${item.title}\n${description}\n\n${content}`,
        metadata: itemMetadata(id, 'fulltext', item)
      })
    } else {
      const provenance = [item.url, String(item.date_published || '').slice(0, 10), tags && `tags: ${tags}`]
        .filter(Boolean)
        .join(' · ')
      docs.push({
        text: `${item.title}\n${description}\n${provenance}`,
        metadata: itemMetadata(id, 'bookmark', item)
      })
    }
  }

  return docs
}

async function getExistingSourceIds(): Promise<Set<string>> {
  const existing = new Set<string>()
  let collection
  try {
    collection = await rag.getCollection(ARCHIVE_COLLECTION)
  } catch {
    return existing // collection doesn't exist yet
  }
  const pageSize = 1000
  let offset = 0
  for (;;) {
    const page = await collection.get({ include: ['metadatas'], limit: pageSize, offset })
    const metadatas = page.metadatas || []
    for (const m of metadatas) {
      if (m?.sourceId) existing.add(String(m.sourceId))
    }
    if (metadatas.length < pageSize) break
    offset += pageSize
  }
  return existing
}

async function main() {
  console.log(`Archive: ${archivePath}`)
  console.log(`Collection: ${ARCHIVE_COLLECTION}`)

  if (CLEAN) {
    try {
      await rag.deleteCollection(ARCHIVE_COLLECTION)
      console.log('Cleared existing collection.')
    } catch {
      console.log('No existing collection to clear.')
    }
  }

  const existing = await getExistingSourceIds()
  if (existing.size) console.log(`Already indexed: ${existing.size} items`)

  const allDocs = buildDocs()
  const docs = allDocs.filter((d) => !existing.has(d.metadata.sourceId)).slice(0, LIMIT)
  const byKind = docs.reduce((acc: Record<string, number>, d) => {
    acc[d.metadata.kind] = (acc[d.metadata.kind] || 0) + 1
    return acc
  }, {})
  console.log(`To ingest: ${docs.length} of ${allDocs.length} items — ${JSON.stringify(byKind)}\n`)

  let loaded = 0
  const skippedIds: string[] = []

  const addBatch = async (items: ArchiveDoc[]) => {
    await rag.addTextsToVectorStore(
      ARCHIVE_COLLECTION,
      items.map((d) => d.text),
      { metadatas: items.map((d) => d.metadata) }
    )
  }

  // The embeddings proxy WAF 403s on some payloads (content- and load-dependent). Retry with
  // backoff for transient failures; if a batch still fails, bisect it to isolate and skip the
  // offending item(s) rather than aborting the whole run.
  const addWithRecovery = async (items: ArchiveDoc[]) => {
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await addBatch(items)
        loaded += items.length
        console.log(`  ${loaded}/${docs.length} items ingested`)
        return
      } catch (err) {
        if (attempt < maxAttempts) {
          const waitSec = 10 * attempt
          console.warn(`  batch of ${items.length} failed (${err.message?.slice(0, 60)}) — retry in ${waitSec}s`)
          await new Promise((r) => setTimeout(r, waitSec * 1000))
        }
      }
    }
    if (items.length === 1) {
      skippedIds.push(items[0].metadata.sourceId)
      console.warn(`  SKIPPING item ${items[0].metadata.sourceId} ("${items[0].metadata.title?.slice(0, 60)}")`)
      return
    }
    const mid = Math.ceil(items.length / 2)
    await addWithRecovery(items.slice(0, mid))
    await addWithRecovery(items.slice(mid))
  }

  let batch: ArchiveDoc[] = []
  let batchChunks = 0
  for (const doc of docs) {
    const estChunks = Math.max(1, Math.ceil(doc.text.length / CHUNK_SIZE_ESTIMATE))
    if (batch.length > 0 && batchChunks + estChunks > MAX_CHUNKS_PER_BATCH) {
      await addWithRecovery(batch)
      batch = []
      batchChunks = 0
    }
    batch.push(doc)
    batchChunks += estChunks
  }
  if (batch.length) await addWithRecovery(batch)
  if (skippedIds.length) console.warn(`\nSkipped ${skippedIds.length} item(s): ${skippedIds.join(', ')}`)

  await rag.checkCollections()
  console.log(`\nDone. Ingested ${loaded} items (${existing.size} were already present).`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
