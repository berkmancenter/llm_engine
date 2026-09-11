import { Umzug, MongoDBStorage } from 'umzug'
import logger from '../src/config/logger.js'
import type { MigrationContext, MigrationDb } from './context.js'
import renameLegacyAgentJobNames from './20260824000000-rename-legacy-agent-job-names.js'
import migrateLegacyUserRoles from './20260825000000-migrate-legacy-user-roles.js'

/* Every migration this project has ever needed, hand-listed in the order it must run -
   deliberately not glob-discovered off the filesystem, so the run order is exactly this
   array's order and doesn't depend on filename sort behaving correctly forever. Add a new
   migration at the END of this array; never reorder or remove a shipped entry, since
   `name` is the durable identity umzug records in the `migrations` collection to decide
   what's already applied - renaming or reordering an entry here makes it look unapplied
   everywhere it already ran. */
const migrations = [renameLegacyAgentJobNames, migrateLegacyUserRoles]

/* Turns one umzug log event (a plain object like { event: 'migrating', name: '...' }) into
   a single readable line, since the project logger prints a string/format, not an object. */
function formatLogMessage(message: Record<string, unknown>): string {
  return Object.entries(message)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
}

export function buildMigrator({ db }: { db: MigrationDb }): Umzug<MigrationContext> {
  return new Umzug<MigrationContext>({
    migrations,
    context: { db },
    storage: new MongoDBStorage({ collection: db.collection('migrations') }),
    logger: {
      info: (message) => logger.info(formatLogMessage(message)),
      warn: (message) => logger.warn(formatLogMessage(message)),
      error: (message) => logger.error(formatLogMessage(message)),
      debug: (message) => logger.debug(formatLogMessage(message))
    }
  })
}

export type { MigrationContext }
