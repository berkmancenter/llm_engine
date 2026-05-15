/**
 * Loads the Chroma vector store with material for agent RAG
 * USAGE:
 * NODE_ENV=... node --loader ts-node/esm src/utils/chromaLoadDocs.ts [name of subfolder in rag_documents]
 *
 */
/* eslint-disable no-console */

import fs from 'fs'
import path from 'path'
import rag from '../agents/helpers/rag.js'
import backgroundCollection from '../agents/helpers/backgroundCollection.js'
import config from '../config/config.js'

const CONFIG_FILE = 'config.ts'

async function main(clean = false) {
  const subFolder = process.argv[2]
  if (!subFolder) throw new Error('Must provide a subfolder of rag_documents to load from')

  const folder = path.join(config.ragDocumentsPath, subFolder)
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const files = fs.readdirSync(folder)
  if (!files.includes(CONFIG_FILE)) throw new Error(`RAG folder ${folder} must contain a config.js file`)

  const collectionConfig = {
    ...(await import(path.join('../../', folder, CONFIG_FILE))).default
  }

  if (!collectionConfig.collectionName) collectionConfig.collectionName = subFolder.replace(/[^a-z0-9]/gi, '_').toLowerCase()
  if (!collectionConfig.citations) collectionConfig.citations = {}
  if (!collectionConfig.shortCitations) collectionConfig.shortCitations = {}

  console.log('Config', collectionConfig)

  if (clean) {
    const { collectionName } = collectionConfig
    try {
      await rag.deleteCollection(collectionName)
    } catch {
      console.log(`Could not delete collection ${collectionName} - probably does not exist`)
    }
    rag.createCollection(collectionName)
  }

  for (const file of files) {
    if (file === CONFIG_FILE) continue
    if (path.parse(file).ext !== '.pdf') {
      console.log(`Skipping non-PDF file ${file}`)
      continue
    }
    try {
      const citation = collectionConfig.citations[file] || file
      const shortCitation = collectionConfig.shortCitations[file] || file
      console.log(`Start loading ${file} (Citation: ${citation}) (Short citation: ${shortCitation})...`)
      await backgroundCollection.loadPdfIntoCollection(
        collectionConfig.collectionName,
        path.join(folder, file),
        citation,
        shortCitation
      )
    } catch (error) {
      console.error('Error loading PDF:', file, error)
    }
  }

  try {
    await rag.checkCollections()
  } catch (error) {
    console.error('Error checking ChromaDB collections:', error)
  }
}

main(true)
