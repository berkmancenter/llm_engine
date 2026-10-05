import mongoose from 'mongoose'
import { Announcement } from '../../types/index.types.js'
import { toJSON } from '../plugins/index.js'

/* Embedded subdocument, not a top-level model: announcements are never queried outside their
   conversation and cascade-delete naturally with it, same reasoning as resourceSchema in
   conversation.model.ts. Lives in its own file (like transcript.schema.ts) rather than inline,
   since it also owns a method. */
const announcementSchema = new mongoose.Schema<Announcement>(
  {
    name: { type: String, required: true },
    title: { type: String },
    body: { type: String, required: true }
  },
  { timestamps: true }
)
announcementSchema.plugin(toJSON)

/**
 * Splits `body` into natural read-aloud segments, so each one becomes its own
 * separately-synthesized, separately-paced clip. Organizers write ordinary prose/lists
 * — they never author "segments" directly.
 *
 * Splits on, in order:
 *   1. Blank-line paragraph breaks — the default boundary for ordinary prose.
 *   2. Numbered ("1.", "2)") or bulleted ("-", "*", "•") list item starts, so a list written as
 *      one paragraph with single newlines between items still gets one segment per item.
 */
announcementSchema.method('segments', function () {
  const normalized = this.body.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const paragraphs = normalized.split(/\n\s*\n+/)
  return paragraphs.flatMap((paragraph) =>
    paragraph
      .split(/\n(?=\s*(?:\d+[.)]|[-*•])\s+)/)
      .map((segment) => segment.trim())
      .filter(Boolean)
  )
})

export default announcementSchema
