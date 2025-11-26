/* eslint-disable no-console */
import fs from 'fs'
import mongoose from 'mongoose'
import { loadTranscript } from './transcriptUtils'

/**
 * Parses a chat or live meeting transcript from external clients like YouTube LiveStream or Zoom.
 *
 * Assumes transcript is in the format:
 * [relative timestamp] [delimiter] [user: comment]
 *
 * Creates and saves Messages from the transcript on a given conversation, simulating results of live transcription or chat on side channel.
 * Messages can then be used to test various agents.
 * USAGE:
 * NODE_ENV=... MONGODB_URL=... node --loader ts-node/esm loadTranscript.ts [filename] [conversationId] <optional channel name> <optional delimiter>
 * Specifying the NODE_ENV and MONGODB_URL
 *
 * Channels - leave blank to put on main channel for something like a meeting transcript. Chat transcripts meant to mimic
 * the participant side channel should pass in 'participant'
 *
 * Delimiter between timestamp and username - defaults to -
 */
const args = process.argv.slice(2)
const channels = args[2] ? [args[2]] : []
const delimiter = args[3] ? args[3] : '-'

mongoose.set('strict', true)
await mongoose.connect(process.env.MONGODB_URL as string)

// eslint-disable-next-line security/detect-non-literal-fs-filename
const fileContent = fs.readFileSync(args[0], 'utf-8')
try {
  await loadTranscript(fileContent, args[1], channels, delimiter)
} catch (err) {
  console.error('Error loading transcript:', err)
} finally {
  await mongoose.connection.close()
}
