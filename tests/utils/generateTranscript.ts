/* eslint-disable no-console */
import mongoose from 'mongoose'
import { generateTranscript } from './transcriptUtils'

/**
 * Creates a transcript from messages in a given conversation. Assumes messages are stored on the 'transcript' channel.
 * USAGE:
 * NODE_ENV=... MONGODB_URL=... node --loader ts-node/esm tests/utils/generateTranscript.ts [conversationId]
 * Specifying the NODE_ENV and MONGODB_URL
 *
 */
const args = process.argv.slice(2)

mongoose.set('strict', true)
await mongoose.connect(process.env.MONGODB_URL as string)

try {
  const transcript = await generateTranscript(args[0])
  console.log(transcript)
} catch (err) {
  console.error('Error generating transcript:', err)
} finally {
  await mongoose.connection.close()
}
