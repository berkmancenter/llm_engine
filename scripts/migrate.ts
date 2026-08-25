#!/usr/bin/env node
/**
 * Runs the database migrations tracked in migrations/ (see migrations/index.ts). Umzug
 * records each applied migration's name in the `migrations` collection, so `up` is safe
 * to re-run: anything already applied is skipped.
 *
 * This is a deliberately manual, one-time-per-environment step - not something the boot
 * path runs for you. Run it once per environment, before deploying code that stops
 * supporting whatever the migration is converting away from (see each migration file's
 * own comment for what happens if that order is skipped).
 *
 * Commands:
 *   status              List applied and pending migrations. Makes no changes.
 *   up [--to=<name>]     Apply all pending migrations, or up to and including <name>.
 *   down [--to=<name>]   Revert the most recently applied migration, or down to (and
 *                        excluding) <name>. Pass --to=0 to revert every migration.
 *
 * RUNNING IT:
 *
 *   # See what's pending before touching anything
 *   NODE_ENV=production node --loader ts-node/esm scripts/migrate.ts status
 *
 *   # Apply everything pending
 *   NODE_ENV=production node --loader ts-node/esm scripts/migrate.ts up
 */
/* eslint-disable no-console */

import mongoose from 'mongoose'
import { pathToFileURL } from 'url'
import config from '../src/config/config.js'
import { buildMigrator } from '../migrations/index.js'

const COMMANDS = ['status', 'up', 'down'] as const
type Command = (typeof COMMANDS)[number]

function isCommand(value: string | undefined): value is Command {
  return !!value && (COMMANDS as readonly string[]).includes(value)
}

function parseFlag(flag: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`${flag}=`))?.split('=')[1]
}

function namesOrNone(entries: Array<{ name: string }>): string {
  return entries.map((entry) => entry.name).join(', ') || '(none)'
}

async function main() {
  const command = process.argv[2]
  if (!isCommand(command)) {
    console.error(`Usage: migrate.ts <${COMMANDS.join('|')}> [--to=<name>]`)
    process.exitCode = 1
    return
  }

  mongoose.set('strict', true)
  await mongoose.connect(config.mongoose.url, config.mongoose.options)
  console.log('Connected to MongoDB.')

  try {
    const { db } = mongoose.connection
    if (!db) throw new Error('mongoose.connection.db is unavailable after connect()')
    const migrator = buildMigrator({ db })

    if (command === 'status') {
      const [executed, pending] = await Promise.all([migrator.executed(), migrator.pending()])
      console.log(`Applied (${executed.length}): ${namesOrNone(executed)}`)
      console.log(`Pending (${pending.length}): ${namesOrNone(pending)}`)
      return
    }

    const to = parseFlag('--to')
    if (command === 'up') {
      const applied = await migrator.up(to ? { to } : undefined)
      console.log(`Applied ${applied.length} migration(s): ${namesOrNone(applied)}`)
    } else {
      const reverted = await migrator.down(to !== undefined ? { to: to === '0' ? 0 : to } : undefined)
      console.log(`Reverted ${reverted.length} migration(s): ${namesOrNone(reverted)}`)
    }
  } finally {
    await mongoose.connection.close()
    console.log('Connection closed.')
  }
}

// Only connect and run when invoked directly, so importing this module (e.g. in a test)
// does not open a database connection or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
