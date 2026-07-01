/**
 * Loads all conversations for a topic into both the per-conversation and topic-level
 * transcript vector stores. Skips conversations already present in the topic collection.
 *
 * USAGE:
 * NODE_ENV=... node --loader ts-node/esm src/utils/loadTopicTranscripts.ts [topicId]
 *
 * If topicId is omitted, loads all public (private=false) topics.
 */
/* eslint-disable no-console */

import mongoose from 'mongoose'
import config from '../config/config.js'
import transcript from '../agents/helpers/transcript.js'
import rag from '../agents/helpers/rag.js'
import Topic from '../models/topic.model.js'

async function main() {
  const topicId = process.argv[2]

  mongoose.set('strict', true)
  await mongoose.connect(config.mongoose.url, config.mongoose.options)
  console.log('Connected to MongoDB')

  try {
    const topicIds = topicId
      ? [topicId]
      : (await Topic.find({ private: false }).select('_id').lean()).map((t) => t._id.toString())

    if (topicIds.length === 0) {
      console.log('No topics found.')
      return
    }

    console.log(`Processing ${topicIds.length} topic(s)...`)
    let totalLoaded = 0
    let totalSkipped = 0

    for (const id of topicIds) {
      const result = await transcript.loadTopicTranscriptsIntoVectorStore(id)
      console.log(`Topic ${id}: loaded ${result.loaded}, skipped ${result.skipped}`)
      totalLoaded += result.loaded
      totalSkipped += result.skipped
    }

    console.log(`Done. Total loaded: ${totalLoaded}, skipped: ${totalSkipped}`)
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
