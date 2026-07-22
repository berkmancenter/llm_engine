/* eslint-disable security/detect-non-literal-fs-filename */
import fs from 'fs'
import path from 'path'
import mongoose from 'mongoose'
import httpStatus from 'http-status'
import { z } from 'zod'
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf'
import backgroundCollection, { BACKGROUND_DOCS_BASE, buildFullCitation } from '../agents/helpers/backgroundCollection.js'
import { getModelChat, coreLLMPlatform, coreLLMModel } from '../agents/helpers/getModelChat.js'
import { getChatPromptResponse } from '../agents/helpers/llmChain.js'
import logger from '../config/logger.js'
import Conversation from '../models/conversation.model.js'
import schedule from '../jobs/schedule.js'
import websocketGateway from '../websockets/websocketGateway.js'
import ApiError from '../utils/ApiError.js'

const resourceSummarySchema = z.object({
  mainThesis: z.array(z.string()).describe('The central argument or purpose of the resource as 1–2 bullet points.'),
  keyFindings: z.array(z.string()).describe('The most important results or arguments as 2–4 bullet points.'),
  methodology: z
    .array(z.string())
    .optional()
    .describe(
      'The research method or study design as 1–2 bullet points. Omit entirely if the resource does not describe a specific method or study.'
    ),
  practicalRelevance: z
    .array(z.string())
    .describe('Why this matters or how it connects to real-world practice as 1–2 bullet points.')
})

export function formatSummary(s: z.infer<typeof resourceSummarySchema>) {
  /* The LLM occasionally returns a plain string for a single-item list field.
     Coerce to an array so .map() doesn't crash on malformed Bedrock tool-call output. */
  const toList = (items: unknown): string[] => (Array.isArray(items) ? (items as string[]) : [String(items)])
  const bullets = (items: unknown) =>
    toList(items)
      .map((b) => `- ${b}`)
      .join('\n')
  const sections = [
    `**Main Thesis**\n${bullets(s.mainThesis)}`,
    `**Key Findings**\n${bullets(s.keyFindings)}`,
    ...(s.methodology ? [`**Methodology**\n${bullets(s.methodology)}`] : []),
    `**Practical Relevance**\n${bullets(s.practicalRelevance)}`
  ]
  return sections.join('\n\n')
}

const PDF_MAX_CHARS_FOR_SUMMARY = 400_000

const SUMMARIZATION_PROMPT =
  'You are writing cognitive support summaries to help people with executive function differences ' +
  'or other cognitive needs quickly get up to speed on academic readings before an event. ' +
  'Each field should be a list of short, plain-English bullet points. ' +
  'Write like you are explaining to a smart non-specialist — no jargon, no complex sentence structure, ' +
  'no hedging phrases like "the authors argue" or "this paper posits". ' +
  'Every bullet should be a simple, direct statement. ' +
  'Target 150 words total across all fields.'

const summarizePdf = async (conversationId: string, resourceId: string, filePath: string, citation: string) => {
  const loader = new PDFLoader(filePath)
  const docs = await loader.load()
  let content = docs.map((d) => d.pageContent).join('\n')
  if (content.length > PDF_MAX_CHARS_FOR_SUMMARY) {
    logger.warn(`resource.service: PDF for resource ${resourceId} exceeds ${PDF_MAX_CHARS_FOR_SUMMARY} chars, truncating`)
    content = content.slice(0, PDF_MAX_CHARS_FOR_SUMMARY)
  }

  const llm = await getModelChat(coreLLMPlatform, coreLLMModel)
  const structured = await getChatPromptResponse(
    llm,
    SUMMARIZATION_PROMPT,
    'Citation: {citation}\n\n{content}',
    { citation, content },
    undefined,
    resourceSummarySchema
  )
  const summary = formatSummary(structured as z.infer<typeof resourceSummarySchema>)

  await Conversation.updateOne(
    { _id: conversationId, 'resources._id': new mongoose.Types.ObjectId(resourceId) },
    { $set: { 'resources.$.summary': summary } }
  ).exec()

  logger.info(`resource.service: generated summary for resource ${resourceId}`)
}

const savePdf = async (conversationId: string, resourceId: string, fileBuffer: Buffer, user) => {
  const conv = await Conversation.findOne({
    _id: conversationId,
    'resources._id': new mongoose.Types.ObjectId(resourceId)
  })
    .select('resources owner topic')
    .populate('topic', 'owner')
    .lean()
    .exec()

  if (!conv) {
    throw new ApiError(httpStatus.NOT_FOUND, `Resource ${resourceId} not found in conversation ${conversationId}`)
  }

  const userId = user._id.toString()
  const isConvOwner = conv.owner.toString() === userId
  const isTopicOwner = conv.topic?.owner?.toString() === userId
  if (!isConvOwner && !isTopicOwner) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only conversation or topic owner can upload resources')
  }

  const dir = path.join(BACKGROUND_DOCS_BASE, conversationId)
  fs.mkdirSync(dir, { recursive: true })
  const fileName = `${resourceId}.pdf`
  const filePath = path.join(dir, fileName)
  fs.writeFileSync(filePath, fileBuffer)
  logger.info(`resource.service: wrote PDF to ${filePath}`)

  await Conversation.updateOne(
    { _id: conversationId, 'resources._id': new mongoose.Types.ObjectId(resourceId) },
    { $set: { 'resources.$.fileName': fileName } }
  ).exec()

  const resource = conv.resources.find((r) => r._id!.toString() === resourceId)
  if (resource) {
    try {
      await backgroundCollection.loadPdfIntoChroma(conversationId, { ...resource, fileName })
    } catch (err) {
      logger.warn(`resource.service: failed to load PDF into Chroma for resource ${resourceId}: ${err}`)
    }

    if (resource.category === 'required') {
      const citation = buildFullCitation({ ...resource, fileName })
      await schedule.summarizePdf({ conversationId, resourceId, filePath, citation })
    }
  }
  return fileName
}

// Matches incoming resources to existing ones by id, carrying over fileName.
// Strips id (client-side correlation field), deletes orphaned PDF files, and rebuilds the Chroma collection.
const updateResources = async (conversationId: string, oldResources, incomingResources) => {
  const reconciled = incomingResources.map(({ id, ...r }) => {
    if (!id) return r
    const existing = oldResources.find((old) => old._id!.toString() === id)
    return existing?.fileName ? { ...r, fileName: existing.fileName } : r
  })

  for (const old of oldResources) {
    if (!old.fileName) continue
    const stillPresent = reconciled.some((r) => r.fileName === old.fileName)
    if (!stillPresent) {
      const filePath = path.join(BACKGROUND_DOCS_BASE, conversationId, old.fileName)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
        logger.info(`resource.service: deleted orphaned PDF ${filePath}`)
      }
    }
  }

  try {
    await backgroundCollection.loadBackgroundCollection(conversationId, reconciled)
  } catch (err) {
    logger.warn(`resource.service: failed to rebuild Chroma collection for ${conversationId}: ${err}`)
  }

  return reconciled
}

const addResources = async (newResources, conversationId) => {
  const conv = await Conversation.findByIdAndUpdate(
    conversationId,
    { $push: { resources: { $each: newResources } } },
    { new: true }
  )
    .select('resources')
    .exec()

  if (!conv) {
    throw new Error(`addResources: conversation ${conversationId} not found`)
  }

  websocketGateway.broadcastResourcesUpdated(conversationId, conv.resources as unknown[])
}

const deleteResources = async (conversationId: string) => {
  try {
    await backgroundCollection.deleteBackgroundCollection(conversationId)
  } catch (err) {
    logger.warn(`resource.service: failed to delete Chroma collection for ${conversationId}: ${err}`)
  }
  const dir = path.join(BACKGROUND_DOCS_BASE, conversationId)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
    logger.info(`resource.service: removed background docs dir ${dir}`)
  }
}

const resourceService = { savePdf, summarizePdf, updateResources, addResources, deleteResources }
export default resourceService
