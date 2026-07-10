/**
 * Ingest the BKC markdown archive into a topic-transcript Chroma collection so the
 * eventHistorian's `search_topic_transcripts` tool can retrieve it.
 *
 * Each .md file's body is chunked and embedded (document embeddings, 3072-dim), with
 * metadata.conversationName set to the page title so the historian labels its sources.
 *
 * Usage:
 *   NODE_ENV=development node --loader ts-node/esm scripts/loadArchiveIntoTopic.ts [archiveRoot] [topicId] [--limit N]
 * Defaults: archiveRoot=../archive/archive-wiki  topicId=6a3aa64e06185cf4db825321
 */
/* eslint-disable no-console */
import fs from 'fs'
import path from 'path'
import rag from '../src/agents/helpers/rag.js'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const limitArg = process.argv.find((a) => a.startsWith('--limit='))
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : Infinity

const ARCHIVE_ROOT = path.resolve(args[0] || path.join(process.cwd(), '..', 'archive', 'archive-wiki'))
const TOPIC_ID = args[1] || '6a3aa64e06185cf4db825321'
const COLLECTION = `topic-transcript-${TOPIC_ID}`
const INCLUDE_DIRS = ['items', 'topics', 'orgs', 'people', 'sources', 'timeline']

function walk(dir: string): string[] {
  const out: string[] = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

function parse(raw: string) {
  const meta: Record<string, string> = {}
  let body = raw
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3)
    if (end !== -1) {
      const fm = raw.slice(3, end)
      body = raw.slice(end + 4).trim()
      for (const line of fm.split('\n')) {
        const m = line.match(/^([a-z_]+):\s*(.*)$/i)
        if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
      }
    }
  }
  return { meta, body }
}

async function main() {
  const files = INCLUDE_DIRS.flatMap((d) => walk(path.join(ARCHIVE_ROOT, d))).slice(0, LIMIT)
  console.log(`Archive: ${ARCHIVE_ROOT}`)
  console.log(`Collection: ${COLLECTION}`)
  console.log(`Files to ingest: ${files.length}\n`)

  if (process.argv.includes('--clean')) {
    try {
      await rag.deleteCollection(COLLECTION)
      console.log('Cleared existing collection.\n')
    } catch {
      console.log('No existing collection to clear.\n')
    }
  }

  let ok = 0
  let skipped = 0
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const { meta, body } = parse(fs.readFileSync(file, 'utf8'))
    if (!body || body.length < 40) {
      skipped++
      continue
    }
    const title = meta.title || path.basename(file, '.md')
    try {
      await rag.addTextsToVectorStore(COLLECTION, [body], {
        metadatas: [
          {
            conversationName: title,
            source: meta.source || '',
            url: meta.url || '',
            date: meta.date || '',
            archiveType: meta.type || 'item'
          }
        ]
      })
      ok++
    } catch (e) {
      console.error(`  FAIL ${path.basename(file)}: ${(e as Error).message}`)
      skipped++
    }
    if ((i + 1) % 25 === 0 || i === files.length - 1) console.log(`  ${i + 1}/${files.length} processed (ok=${ok}, skipped=${skipped})`)
  }
  console.log(`\nDone. Ingested ${ok} files, skipped ${skipped}.`)
}

await main()
