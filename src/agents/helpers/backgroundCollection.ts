import path from 'path'
import fs from 'fs'
import rag from './rag.js'
import logger from '../../config/logger.js'
import config from '../../config/config.js'
import { Resource } from '../../types/index.types.js'

const BACKGROUND_DOCS_BASE = path.join(config.ragDocumentsPath, 'background')

const conversationCollectionName = (conversationId: string) => `background-${conversationId}`

const pdfPath = (conversationId: string, fileName: string) => path.join(BACKGROUND_DOCS_BASE, conversationId, fileName)

function buildFullCitation(resource: Resource) {
  return resource.citation || [resource.title, resource.authors?.join(', '), resource.year].filter(Boolean).join(', ')
}

async function loadPdfIntoCollection(collectionName: string, filePath: string, citation: string, shortCitation: string) {
  const metadataFn = (doc) => ({
    ...doc,
    metadata: {
      pdf: path.basename(filePath),
      pageNumber: doc.metadata.loc?.pageNumber,
      lineFrom: doc.metadata.loc?.lines?.from,
      lineTo: doc.metadata.loc?.lines?.to,
      citation,
      shortCitation
    }
  })
  await rag.addPDFToVectorStore(collectionName, filePath, metadataFn)
}

async function loadPdfIntoChroma(conversationId: string, resource: Resource) {
  if (!resource.fileName) return

  const filePath = pdfPath(conversationId, resource.fileName)
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!fs.existsSync(filePath)) {
    logger.warn(`backgroundCollection: file ${filePath} does not exist, skipping loading resource ${resource.title}`)
    return
  }
  const citation = buildFullCitation(resource)
  await loadPdfIntoCollection(conversationCollectionName(conversationId), filePath, citation, resource.title)
  logger.info(`backgroundCollection: loaded PDF "${resource.title}" into ${conversationCollectionName(conversationId)}`)
}

async function loadBackgroundCollection(conversationId: string, resources: Resource[]) {
  const collectionName = conversationCollectionName(conversationId)
  try {
    await rag.deleteCollection(collectionName)
  } catch {
    // no existing collection
  }
  logger.info(`backgroundCollection: rebuilding collection for ${conversationId}`)
  for (const resource of resources) {
    await loadPdfIntoChroma(conversationId, resource)
  }
}

export default {
  loadPdfIntoChroma,
  loadBackgroundCollection,
  loadPdfIntoCollection
}
