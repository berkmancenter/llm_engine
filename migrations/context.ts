import type { Connection } from 'mongoose'

/* The raw MongoDB driver database handle, typed off mongoose's own `Connection.db` rather
   than importing the `mongodb` package directly - `mongodb` is only a transitive
   dependency here (mongoose's), not one of ours, but mongoose's public `Connection.db`
   field already carries this exact type, so this borrows it instead of depending on a
   package we don't declare. */
export type MigrationDb = NonNullable<Connection['db']>

/* Passed to every migration's up/down as `context`. Kept to just the raw db handle: a
   migration operates on collections directly (see the "why not mongoose models" note in
   each migration file, where relevant), not through the application's Mongoose models,
   since a migration must keep working even after the schema/model it once matched has
   moved on. */
export interface MigrationContext {
  db: MigrationDb
}
