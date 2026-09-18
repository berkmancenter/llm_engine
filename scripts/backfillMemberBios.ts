#!/usr/bin/env node
/**
 * Backfills member bio/interests into Chroma for one or more conversations, without
 * touching MongoDB records. Useful when the RAG collection was never populated (e.g.
 * the feature was deployed after members were already imported) or when a Chroma write
 * silently failed during the original CSV import.
 *
 * Each member's prior Chroma entry is removed then re-added (same logic as indexMemberBios),
 * so it is safe to run on a conversation that already has a partial collection.
 *
 * Flags:
 *   --conversation=<id>   Conversation ID to reindex (required, repeatable)
 *   --dry-run             Print what would be indexed, but write nothing to Chroma
 *
 * Example:
 *   NODE_ENV=production node --loader ts-node/esm scripts/backfillMemberBios.ts \
 *     --conversation=<id>
 *
 *   # Multiple conversations:
 *   NODE_ENV=production node --loader ts-node/esm scripts/backfillMemberBios.ts \
 *     --conversation=<id1> --conversation=<id2>
 */
/* eslint-disable no-console */

import mongoose from 'mongoose'
import { pathToFileURL } from 'url'
import config from '../src/config/config.js'
import ConversationMembership from '../src/models/conversationMembership.model.js'
import memberBios from '../src/utils/memberBios.js'

const args = process.argv.slice(2)
const conversationIds = args.filter((a) => a.startsWith('--conversation=')).map((a) => a.split('=')[1])
const dryRun = args.includes('--dry-run')

if (conversationIds.length === 0) {
  console.error('Usage: backfillMemberBios.ts --conversation=<id> [--conversation=<id2>] [--dry-run]')
  process.exit(1)
}

async function backfillConversation(conversationId: string) {
  const members = await ConversationMembership.find({ conversation: conversationId, status: 'active' })
    .select('_id name bio interests')
    .lean()
    .exec()

  const indexable = members.filter((m) => m.bio?.trim() || m.interests?.trim())
  const skipped = members.length - indexable.length

  console.log(
    `Conversation ${conversationId}: ${members.length} active members, ` +
      `${indexable.length} with bio/interests, ${skipped} skipped (no content)`
  )

  if (indexable.length === 0) return

  if (dryRun) {
    indexable.forEach((m) => {
      console.log(`  [dry-run] would index: ${m.name} (${m._id})`)
    })
    return
  }

  await memberBios.indexMemberBios(
    conversationId,
    indexable.map((m) => ({
      id: m._id.toString(),
      name: m.name,
      bio: m.bio,
      interests: m.interests
    }))
  )

  console.log(`  Indexed ${indexable.length} members into Chroma.`)
}

async function main() {
  await mongoose.connect(config.mongoose.url, config.mongoose.options)
  console.log(`Connected to MongoDB. dry-run=${dryRun}`)

  for (const id of conversationIds) {
    try {
      await backfillConversation(id)
    } catch (err) {
      console.error(`Failed for conversation ${id}:`, err)
    }
  }

  await mongoose.connection.close()
}

// Allow `await` at the top level when run directly.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
