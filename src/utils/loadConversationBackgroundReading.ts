/**
 * Loads background reading resources for an existing conversation into its Chroma collection.
 * Deletes and rebuilds the collection from scratch each run.
 * Handles PDF resources from rag_documents/background/{conversationId}/
 *
 * USAGE:
 * NODE_ENV=... node --loader ts-node/esm src/utils/loadConversationBackgroundReading.ts <conversationId>
 */
/* eslint-disable no-console */

import mongoose from 'mongoose'
import config from '../config/config.js'
import { Conversation } from '../models/index.js'
import backgroundCollection from '../agents/helpers/backgroundCollection.js'
import { Resource } from '../types/index.types.js'

async function main() {
  const conversationId = process.argv[2]

  if (!conversationId) throw new Error('Usage: loadConversationBackgroundReading.ts <conversationId>')

  mongoose.set('strict', true)
  await mongoose.connect(config.mongoose.url, config.mongoose.options)
  console.log('Connected to MongoDB')

  try {
    const conversation = await Conversation.findById(conversationId).select('resources').exec()
    if (!conversation) throw new Error(`Conversation ${conversationId} not found`)

    const speakerResources = (conversation.resources as unknown as Resource[]).filter((r) => r.source === 'speaker')
    console.log(`Found ${speakerResources.length} speaker resource(s)`)

    await backgroundCollection.loadBackgroundCollection(conversationId, speakerResources)
    console.log(`Loaded ${speakerResources.length} resource(s) into collection`)
  } finally {
    await mongoose.connection.close()
    console.log('Connection closed.')
    process.exit(0)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
