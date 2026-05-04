/**
 * Loads all conversations for a topic into both the per-conversation and topic-level
 * transcript vector stores. Skips conversations already present in the topic collection.
 *
 * USAGE:
 * NODE_ENV=... node --loader ts-node/esm src/utils/loadTopicTranscripts.ts <topicId>
 */
/* eslint-disable no-console */

import mongoose from 'mongoose'
import config from '../config/config.js'
import transcript from '../agents/helpers/transcript.js'
import rag from '../agents/helpers/rag.js'

async function main() {
  const topicId = process.argv[2]
  if (!topicId) throw new Error('Usage: loadTopicTranscripts.ts <topicId>')

  mongoose.set('strict', true)
  await mongoose.connect(config.mongoose.url, config.mongoose.options)
  console.log('Connected to MongoDB')

  try {
    const result = await transcript.loadTopicTranscriptsIntoVectorStore(topicId)
    console.log(`Loaded ${result.loaded} conversations, skipped ${result.skipped}`)

    await rag.checkCollections()
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
