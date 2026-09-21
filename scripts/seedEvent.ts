#!/usr/bin/env node
/**
 * Seeds a local database with one ended event that has a transcript, so an artifact
 * (e.g. a concept graph) can be generated and viewed in the web client without running
 * a real Zoom session. Nothing here calls the artifact generator: open the printed
 * /artifacts URL as an admin and click Generate.
 *
 * Flags:
 *   --topic "<name>"        Topic (series) name. Default "Seeded series".
 *   --event "<name>"        Conversation (event) name. Default "Seeded event".
 *   --users N               Participant users to create and rotate speakers over. Default 4.
 *   --transcript <path>     "Speaker: text" file. Default scripts/transcripts/living-with-assistants.txt
 *   --generate "<brief>"    Ask the configured core model for a transcript instead of reading a file.
 *   --owner <username>      Existing user to own the topic and event. Default: the first seeded user.
 *   --allow-remote          Permit a non-localhost MONGODB_URL.
 *   --clean                 Delete everything earlier seed runs created, then exit.
 *
 *   node --loader ts-node/esm scripts/seedEvent.ts --users 4
 *   node --loader ts-node/esm scripts/seedEvent.ts --generate "a panel on living with LLM assistants" --owner admin
 *   node --loader ts-node/esm scripts/seedEvent.ts --clean
 */
import { readFile } from 'fs/promises'
import mongoose from 'mongoose'
import { pathToFileURL } from 'url'
import config from '../src/config/config.js'
import { Channel, Conversation, Message, Topic, User } from '../src/models/index.js'

/* eslint-disable no-console */

/* Same names as GRAPH_SOURCE_CHANNELS in services/conceptGraph, spelled out here because
   importing either that module or conversations/eventAssistant drags in the model providers
   and agenda, which a file-based seed should never load. */
const TRANSCRIPT_CHANNEL = 'transcript'
const CHAT_CHANNEL = 'chat'

export const SEED_USERNAME_PREFIX = 'seed-'
const SEED_MARK = 'Seeded by scripts/seedEvent.ts'
const DEFAULT_TRANSCRIPT = 'scripts/transcripts/living-with-assistants.txt'

const SECONDS_BETWEEN_UTTERANCES = 20
const MINUTES_BEFORE_FIRST_UTTERANCE = 1
const MIN_EVENT_MINUTES = 60

export interface TranscriptLine {
  speaker: string
  text: string
}

export interface SeedOptions {
  topicName: string
  eventName: string
  userCount: number
  transcript: TranscriptLine[]
  ownerUsername?: string
}

export interface SeedResult {
  topicId: string
  conversationId: string
  userIds: string[]
  messageCount: number
}

/** Anything a chat model returns that has an `invoke`; kept minimal so tests can pass a fake. */
export interface TranscriptModel {
  invoke(prompt: string): Promise<{ content: unknown }>
}

export function assertSafeTarget({
  nodeEnv,
  mongoUrl,
  allowRemote = false
}: {
  nodeEnv: string
  mongoUrl: string
  allowRemote?: boolean
}) {
  if (nodeEnv === 'production') {
    throw new Error('seedEvent refuses to run with NODE_ENV=production')
  }
  const host = new URL(mongoUrl).hostname
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (!isLocal && !allowRemote) {
    throw new Error(`MONGODB_URL points at ${host}, not localhost. Pass --allow-remote if you really mean it.`)
  }
}

export function parseTranscript(text: string): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([^:]{1,60}):\s*(.+)$/)
    if (match) {
      lines.push({ speaker: match[1].trim(), text: match[2].trim() })
    } else if (lines.length > 0) {
      lines[lines.length - 1].text += ` ${line}`
    }
  }
  return lines
}

const contentToText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('\n')
  }
  return ''
}

export async function generateTranscript(
  brief: string,
  { speakers, llm, turns = 40 }: { speakers: string[]; llm: TranscriptModel; turns?: number }
): Promise<TranscriptLine[]> {
  const prompt = [
    `Write a realistic transcript of a live group discussion. Brief: ${brief}`,
    `Speakers, by first name only: ${speakers.join(', ')}.`,
    `About ${turns} turns. Each turn is one line in the exact form "Name: what they said".`,
    'Speakers should disagree, build on each other, and name concrete concepts. No stage directions,',
    'no headings, no numbering, no markdown, nothing but the transcript lines.'
  ].join('\n')
  const reply = await llm.invoke(prompt)
  const lines = parseTranscript(contentToText(reply.content))
  if (lines.length === 0) {
    throw new Error(`The model returned no transcript lines. Reply was:\n${contentToText(reply.content)}`)
  }
  return lines
}

const seedUser = (index: number, runId: string) =>
  User.create({
    username: `${SEED_USERNAME_PREFIX}${runId}-${index + 1}`,
    role: 'participant',
    pseudonyms: [{ token: `${runId}-${index + 1}`, pseudonym: `Seeded Participant ${index + 1}`, active: true }]
  })

const findOwner = async (username: string) => {
  const owner = await User.findOne({ username })
  if (!owner) throw new Error(`No user with username "${username}" to own the seeded event`)
  return owner
}

export async function seedEvent(options: SeedOptions): Promise<SeedResult> {
  const runId = new mongoose.Types.ObjectId().toString().slice(-6)
  const users = await Promise.all(Array.from({ length: options.userCount }, (_, i) => seedUser(i, runId)))
  const owner = options.ownerUsername ? await findOwner(options.ownerUsername) : users[0]
  if (!owner) throw new Error('Nothing can own the event: pass --users of at least 1 or --owner <username>')

  const topic = await Topic.create({
    name: options.topicName,
    slug: `${options.topicName}-${runId}`,
    description: SEED_MARK,
    votingAllowed: false,
    conversationCreationAllowed: true,
    private: false,
    archivable: false,
    owner: owner._id
  })

  const startTime = new Date(Date.now() - 2 * 60 * 60 * 1000) // 2 hours ago
  const firstUtterance = startTime.getTime() + MINUTES_BEFORE_FIRST_UTTERANCE * 60 * 1000
  const lastUtterance = firstUtterance + Math.max(options.transcript.length - 1, 0) * SECONDS_BETWEEN_UTTERANCES * 1000
  const endTime = new Date(Math.max(lastUtterance + 60 * 1000, startTime.getTime() + MIN_EVENT_MINUTES * 60 * 1000))

  const conversation = await Conversation.create({
    name: options.eventName,
    slug: `${options.eventName}-${runId}`,
    description: SEED_MARK,
    owner: owner._id,
    topic: topic._id,
    active: false,
    draft: false,
    startTime,
    endTime,
    transcript: { status: 'stopped' }
  })
  const channels = await Channel.create([{ name: TRANSCRIPT_CHANNEL }, { name: CHAT_CHANNEL }])
  conversation.channels.push(...channels)
  await conversation.save()
  topic.conversations.push(conversation.toObject())
  await topic.save()

  /* Speakers are assigned to users in order of first appearance so a transcript with more
     speakers than users still seeds: the extra speakers share a user, which is fine for a
     graph that never renders who said what. */
  const userForSpeaker = new Map<string, (typeof users)[number]>()
  for (const line of options.transcript) {
    if (!userForSpeaker.has(line.speaker)) {
      userForSpeaker.set(line.speaker, users[userForSpeaker.size % users.length])
    }
  }

  await Message.create(
    options.transcript.map((line, i) => {
      const user = userForSpeaker.get(line.speaker)!
      const pseudonym = user.pseudonyms[0]
      return {
        body: line.text,
        conversation: conversation._id,
        owner: user._id,
        pseudonym: pseudonym.pseudonym,
        pseudonymId: pseudonym._id,
        fromAgent: false,
        channels: [TRANSCRIPT_CHANNEL],
        createdAt: new Date(firstUtterance + i * SECONDS_BETWEEN_UTTERANCES * 1000)
      }
    })
  )

  return {
    topicId: topic._id.toString(),
    conversationId: conversation._id.toString(),
    userIds: users.map((u) => u._id.toString()),
    messageCount: options.transcript.length
  }
}

export async function cleanSeededEvents() {
  const topics = await Topic.find({ description: SEED_MARK }).select('_id').lean()
  const topicIds = topics.map((t) => t._id)
  const conversations = await Conversation.find({ topic: { $in: topicIds } })
    .select('_id channels')
    .lean()
  const conversationIds = conversations.map((c) => c._id)
  const channelIds = conversations.flatMap((c) => c.channels ?? [])

  const [messages, channels, removedConversations, removedTopics, users] = await Promise.all([
    Message.deleteMany({ conversation: { $in: conversationIds } }),
    Channel.deleteMany({ _id: { $in: channelIds } }),
    Conversation.deleteMany({ _id: { $in: conversationIds } }),
    Topic.deleteMany({ _id: { $in: topicIds } }),
    User.deleteMany({ username: new RegExp(`^${SEED_USERNAME_PREFIX}`) })
  ])

  return {
    topics: removedTopics.deletedCount,
    conversations: removedConversations.deletedCount,
    channels: channels.deletedCount,
    messages: messages.deletedCount,
    users: users.deletedCount
  }
}

const flagValue = (name: string): string | undefined => {
  const withEquals = process.argv.find((arg) => arg.startsWith(`${name}=`))
  if (withEquals) return withEquals.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const allowRemote = process.argv.includes('--allow-remote')
  assertSafeTarget({ nodeEnv: config.env, mongoUrl: config.mongoose.url, allowRemote })

  mongoose.set('strict', true)
  await mongoose.connect(config.mongoose.url, config.mongoose.options)
  console.log(`Connected to ${new URL(config.mongoose.url).host}`)

  try {
    if (process.argv.includes('--clean')) {
      const removed = await cleanSeededEvents()
      console.log('Removed:', removed)
      return
    }

    const userCount = Number(flagValue('--users') ?? 4)
    if (!Number.isInteger(userCount) || userCount < 1) throw new Error('--users must be a whole number of at least 1')

    const brief = flagValue('--generate')
    let transcript: TranscriptLine[]
    if (brief) {
      // Imported here so a plain file-based seed never loads any model provider.
      const { getModelChat, coreLLMPlatform, coreLLMModel } = await import('../src/agents/helpers/getModelChat.js')
      const speakers = ['Maya', 'Theo', 'Priya', 'Jonah', 'Lena', 'Omar', 'Sofia', 'Kai'].slice(0, userCount)
      console.log(`Asking ${coreLLMPlatform}/${coreLLMModel} for a transcript...`)
      const llm = (await getModelChat(coreLLMPlatform, coreLLMModel, { maxTokens: 4000 })) as TranscriptModel
      transcript = await generateTranscript(brief, { speakers, llm })
    } else {
      const path = flagValue('--transcript') ?? DEFAULT_TRANSCRIPT
      // The path is the operator's own flag on a local dev tool, not request input.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      transcript = parseTranscript(await readFile(path, 'utf8'))
      if (transcript.length === 0) throw new Error(`No "Speaker: text" lines found in ${path}`)
    }

    const result = await seedEvent({
      topicName: flagValue('--topic') ?? 'Seeded series',
      eventName: flagValue('--event') ?? 'Seeded event',
      userCount,
      transcript,
      ownerUsername: flagValue('--owner')
    })

    const base = config.nextspaceUrl ?? ''
    console.log(`Seeded ${result.messageCount} transcript messages from ${result.userIds.length} users.`)
    console.log(`  topicId:        ${result.topicId}`)
    console.log(`  conversationId: ${result.conversationId}`)
    console.log(`  event artifacts:  ${base}/artifacts/${result.conversationId}`)
    console.log(`  series artifacts: ${base}/artifacts/topic/${result.topicId}`)
    console.log('Open the artifacts page in the web client as an admin and click Generate to build the concept graph.')
  } finally {
    await mongoose.connection.close()
    // The models' imports leave timers open, so the process would otherwise never exit.
    process.exit(0)
  }
}

// Only connect and run when invoked directly, so importing this module (e.g. in a test) does
// not open a database connection.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
