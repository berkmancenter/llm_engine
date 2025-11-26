import { Chroma } from '@langchain/community/vectorstores/chroma'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { ChromaClient } from 'chromadb'
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf'
import config from '../../config/config.js'
import logger from '../../config/logger.js'
import { getEmbeddings } from './getEmbeddings.js'

export const TRANSCRIPT_COLLECTION_PREFIX = 'event-transcript'

// Can use this to make sure right endpoint and model are being used
// logger.debug(
//   `Embeddings config - ${config.embeddings.openAI.baseUrl}, ${config.embeddings.openAI.documentModel}, ${
//     config.embeddings.openAI.realtimeModel
//   }, ${config.embeddings.openAI.key.slice(config.embeddings.openAI.key.length - 3)} `
// )

const defaultDocumentEmbeddings = getEmbeddings('openai', config.embeddings.openAI.documentModel)

const defaultRealTimeEmbeddings = getEmbeddings('openai', config.embeddings.openAI.realtimeModel)

const client = new ChromaClient({
  path: config.chroma.url
})

const noopEmbeddingFunction = {
  generate: async (texts: string[]) => texts.map(() => Array(1536).fill(0))
}

const chunkSize = 1000
const chunkOverlap = 200
// to prevent 502 errors
const BATCH_SIZE = 100

function getFullCollectionName(collectionName) {
  return `${config.chroma.embeddingsCollectionPrefix}-${collectionName || 'unspecified'}`
}

function getVectorStore(collectionName, embeddingsPlatform?, embeddingsModelName?) {
  const collectionFullName = getFullCollectionName(collectionName)
  const providedEmbeddings = embeddingsModelName && getEmbeddings(embeddingsPlatform, embeddingsModelName)
  const embeddings =
    providedEmbeddings || collectionName.startsWith(TRANSCRIPT_COLLECTION_PREFIX)
      ? defaultRealTimeEmbeddings
      : defaultDocumentEmbeddings
  return new Chroma(embeddings, {
    collectionName: collectionFullName,
    url: config.chroma.url,
    collectionMetadata: {
      'hnsw:space': 'cosine'
    }
  })
}

async function createCollection(collectionName) {
  const collectionFullName = getFullCollectionName(collectionName)
  await client.createCollection({ name: collectionFullName })
  logger.info(`Collection created ${collectionFullName}`)
}

async function getCollection(collectionName) {
  const collectionFullName = getFullCollectionName(collectionName)
  return client.getCollection({ name: collectionFullName, embeddingFunction: noopEmbeddingFunction })
}

async function deleteCollection(collectionName) {
  const collectionFullName = getFullCollectionName(collectionName)

  await client.deleteCollection({ name: collectionFullName })
  logger.info(`Collection deleted: ${collectionFullName}`)
}

async function deleteAllCollections() {
  const collections = await client.listCollections()
  const toDelete = collections.filter((col) => col.startsWith(config.chroma.embeddingsCollectionPrefix))
  for (const col of toDelete) {
    await client.deleteCollection({ name: col })
    logger.info(`Deleted collection: ${col}`)
  }
}

async function getContextChunksForQuestion(
  collectionName,
  question,
  formatFn?,
  filter?,
  k = 5,
  embeddingsPlatform?,
  embeddingsModelName?,
  scoreThreshold?
) {
  const vectorStore = getVectorStore(collectionName, embeddingsPlatform, embeddingsModelName)

  const retrievedDocsWithScores = await vectorStore.similaritySearchWithScore(question, k, filter)

  if (!retrievedDocsWithScores.length) {
    logger.warn(`Could not find relevant RAG docs from ${getFullCollectionName(collectionName)}`)
  }

  let retrievedDocs = retrievedDocsWithScores.map(([doc, score]) => ({ ...doc, score }))

  // Filter by score threshold if provided (lower is better for Chroma)
  if (scoreThreshold !== undefined) {
    retrievedDocs = retrievedDocs.filter((doc) => doc.score < scoreThreshold)
  }

  const chunks = formatFn
    ? retrievedDocs.map((doc, idx) => formatFn(doc, idx)).join('\n\n')
    : retrievedDocs.map((doc) => doc.pageContent).join('\n\n')
  return { chunks, retrievedDocs }
}

async function checkCollections() {
  const collections = await client.listCollections()
  logger.info('Available Collections:', collections)

  if (collections.length === 0) {
    logger.info('No collections found.')
    return
  }

  for (const collectionName of collections) {
    const collection = await client.getOrCreateCollection({ name: collectionName })
    const count = await collection.count()
    logger.info(`Number of items in collection '${collectionName}': ${count}`)
  }
}

async function removeFromVectorStore(collectionName, filter) {
  const vectorStore = getVectorStore(collectionName)
  await vectorStore.delete({ filter })
}

async function addTextsToVectorStore(
  collectionName,
  texts,
  options?: {
    metadatas?
    metadataFn?
    embeddingsPlatform?
    embeddingsModelName?
  }
) {
  const vectorStore = getVectorStore(collectionName, options?.embeddingsPlatform, options?.embeddingsModelName)
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap
  })

  const docs = await splitter.createDocuments(texts, options?.metadatas)
  const docsWithMetadata = options?.metadataFn ? docs.map((doc) => options.metadataFn!(doc)) : docs

  // TODO use Hash to see if chunk stored previously?
  logger.debug(`Adding docs to vector store: ${docs.length}...`)
  await vectorStore.addDocuments(docsWithMetadata)
  logger.debug(`Added docs to vector store: ${docs.length}`)
}

async function addPDFToVectorStore(collectionName, file, metadataFn?, embeddingsPlatform?, embeddingsModelName?) {
  const vectorStore = getVectorStore(collectionName, embeddingsPlatform, embeddingsModelName)
  const loader = new PDFLoader(file)
  const pdfMetadata = { pdf: file }
  // Check if the PDF is already indexed.
  const existingDocs = await vectorStore.similaritySearch(' ', 1, pdfMetadata)
  if (existingDocs.length === 0) {
    const docs = await loader.load()
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap
    })
    const allSplits = await splitter.splitDocuments(docs)

    const docsWithMetadata = metadataFn ? allSplits.map((doc) => metadataFn(doc)) : allSplits
    for (let i = 0; i < docsWithMetadata.length; i += BATCH_SIZE) {
      const batch = docsWithMetadata.slice(i, i + BATCH_SIZE)
      await vectorStore.addDocuments(batch)
    }
    logger.info(
      `Finished loading ${file} in ${docsWithMetadata.length} chunks into collection ${getFullCollectionName(
        collectionName
      )}`
    )
  } else {
    logger.info(`No need to load ${file} since it has been pre-loaded.`)
  }
}

export default {
  getContextChunksForQuestion,
  addTextsToVectorStore,
  addPDFToVectorStore,
  removeFromVectorStore,
  createCollection,
  deleteCollection,
  deleteAllCollections,
  checkCollections,
  getCollection
}
