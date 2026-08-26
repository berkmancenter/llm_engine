import Papa from 'papaparse'
import httpStatus from 'http-status'
import logger from '../config/logger.js'
import ApiError from '../utils/ApiError.js'
import Conversation from '../models/conversation.model.js'
import ConversationMembership from '../models/conversationMembership.model.js'
import { matchHeaders, CanonicalField } from '../utils/csvHeaderMatcher.js'
import { sanitizeSingleLineText, sanitizeMultiLineText, sanitizeEmail, SanitizedField } from '../utils/csvRowSanitize.js'

// Conversation types eligible for a member-roster import. A code-level allow list, not an
// env var: extend this when another room type needs the same capability.
const ELIGIBLE_CONVERSATION_TYPES = ['communityRoom']

// Defense-in-depth against a memory-only large-file scenario the multer byte-size cap alone
// wouldn't catch (e.g. a file that's small on disk but expands to many rows).
const MAX_ROWS = 2000

interface RowError {
  row: number
  column: string
  message: string
}

interface ParsedRow {
  email: string
  name: string
  bio: string
  interests: string
}

const sanitizeCell = (field: CanonicalField, raw: unknown): SanitizedField => {
  const str = typeof raw === 'string' ? raw : ''
  if (field === 'email') return sanitizeEmail(str)
  if (field === 'bio') return sanitizeMultiLineText(str)
  return sanitizeSingleLineText(str)
}

const importMembersFromCsv = async (conversationId: string, buffer: Buffer, actingUser) => {
  const conversation = await Conversation.findById(conversationId).select('conversationType').lean().exec()
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Conversation not found')
  }
  if (!ELIGIBLE_CONVERSATION_TYPES.includes(conversation.conversationType ?? '')) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'This conversation type does not support member import')
  }

  // Excel on Windows commonly exports CSV in the system's legacy codepage (e.g.
  // Windows-1252), not UTF-8 — invisible for ASCII names, but it silently mangles an
  // accented one (e.g. "José", "Müller") if decoded as UTF-8 (Buffer#toString('utf8')
  // replaces invalid sequences with U+FFFD rather than erroring). Decode strictly first so
  // a non-UTF-8 upload is a clear, actionable error instead of quietly corrupted names.
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new ApiError(httpStatus.BAD_REQUEST, 'CSV must be UTF-8 encoded (re-save the file as "CSV UTF-8" from Excel)')
  }
  // Strip a UTF-8 BOM real spreadsheet exports commonly include; left in place it folds
  // into the first header's name and breaks matching. Compared/sliced by char code rather
  // than a regex literal containing the BOM character itself, which trips up linting.
  const csvString = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded
  const parsed = Papa.parse(csvString, { header: true, skipEmptyLines: true, dynamicTyping: false })

  const fatalParseError = (parsed.errors ?? []).find((e) => e.type === 'Delimiter')
  if (fatalParseError) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Could not parse file as CSV')
  }

  const rawHeaders: string[] = parsed.meta?.fields ?? []
  if (!rawHeaders.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'CSV has no header row')
  }
  if (!parsed.data.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'CSV has no data rows')
  }
  if (parsed.data.length > MAX_ROWS) {
    throw new ApiError(httpStatus.BAD_REQUEST, `CSV has more than ${MAX_ROWS} rows`)
  }

  const { fieldByHeader, unmatchedRequired } = matchHeaders(rawHeaders)
  if (unmatchedRequired.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Could not identify a column for: ${unmatchedRequired.join(', ')}`)
  }

  /* A row with fewer columns than the header (e.g. a trailing optional column just
     omitted) is left to the normal per-field/required-field checks below — a missing
     column reads the same as a blank cell, which is legitimate. A row with MORE columns
     than the header (an unescaped comma in an unquoted value) is a real hazard, though:
     papaparse silently attributes the overflow to Papa's own __parsed_extra key, which
     means the mapped column it spilled from was truncated. That's silent data corruption
     on a real person's record, so it fails the row outright rather than importing a
     truncated value. */
  const truncationRiskRows = new Set(
    (parsed.errors ?? []).filter((e) => e.code === 'TooManyFields' && typeof e.row === 'number').map((e) => e.row)
  )

  const errors: RowError[] = []
  const failedRows = new Set<number>()
  // Later row in the file wins for a duplicate email; tracked separately from `errors`
  // since a duplicate isn't a validation failure.
  const rowsByEmail = new Map<string, ParsedRow>()
  let duplicateInFile = 0

  ;(parsed.data as Array<Record<string, unknown>>).forEach((rawRow, index) => {
    const sourceRow = index + 2 // header is row 1; humans count rows from there

    if (truncationRiskRows.has(index)) {
      errors.push({ row: sourceRow, column: '(row)', message: 'row has more columns than the header row' })
      failedRows.add(sourceRow)
      return
    }

    const values: Partial<Record<CanonicalField, string>> = {}
    fieldByHeader.forEach((field, header) => {
      const { value, error } = sanitizeCell(field, rawRow[header])
      if (error) {
        errors.push({ row: sourceRow, column: field, message: error })
        failedRows.add(sourceRow)
        return
      }
      values[field] = value
    })
    if (failedRows.has(sourceRow)) return

    if (!values.email) {
      errors.push({ row: sourceRow, column: 'email', message: 'is required' })
      failedRows.add(sourceRow)
      return
    }
    if (!values.firstName && !values.lastName) {
      errors.push({ row: sourceRow, column: 'firstName', message: 'first and last name cannot both be empty' })
      failedRows.add(sourceRow)
      return
    }

    const { email } = values
    if (rowsByEmail.has(email)) duplicateInFile += 1
    rowsByEmail.set(email, {
      email,
      name: [values.firstName, values.lastName].filter(Boolean).join(' '),
      bio: values.bio ?? '',
      interests: values.interests ?? ''
    })
  })

  const rows = [...rowsByEmail.values()]
  let newMembers: Array<{ id: string; email: string }> = []
  let updatedMembers: Array<{ id: string; email: string }> = []

  if (rows.length) {
    const operations = rows.map((row) => ({
      updateOne: {
        filter: { conversation: conversationId, email: row.email },
        update: {
          $set: { conversation: conversationId, email: row.email, name: row.name, bio: row.bio, interests: row.interests },
          // Only applied when inserting: re-import must never re-invite, revive a removed
          // status, or touch alreadyAnnounced/userAccount on an existing record.
          $setOnInsert: { inviteState: 'pending', alreadyAnnounced: false, status: 'active' }
        },
        upsert: true
      }
    }))
    const result = await ConversationMembership.bulkWrite(operations, { ordered: false })

    const upsertedIndexes = new Set(Object.keys(result.upsertedIds ?? {}).map(Number))
    const newEmails = rows.filter((_, i) => upsertedIndexes.has(i)).map((r) => r.email)
    const updatedEmails = rows.filter((_, i) => !upsertedIndexes.has(i)).map((r) => r.email)

    if (newEmails.length) {
      const docs = await ConversationMembership.find({ conversation: conversationId, email: { $in: newEmails } })
        .select('_id email')
        .lean()
        .exec()
      newMembers = docs.map((d) => ({ id: d._id.toString(), email: d.email }))
    }
    if (updatedEmails.length) {
      const docs = await ConversationMembership.find({ conversation: conversationId, email: { $in: updatedEmails } })
        .select('_id email')
        .lean()
        .exec()
      updatedMembers = docs.map((d) => ({ id: d._id.toString(), email: d.email }))
    }
  }

  logger.info(
    `member.service: user ${actingUser._id} imported members into conversation ${conversationId}: ` +
      `${newMembers.length} added, ${updatedMembers.length} updated, ${duplicateInFile} duplicate-in-file, ` +
      `${failedRows.size} failed (rows=${parsed.data.length})`
  )

  return {
    added: newMembers.length,
    updated: updatedMembers.length,
    skipped: duplicateInFile,
    failed: failedRows.size,
    newMembers,
    updatedMembers,
    errors
  }
}

const memberService = { importMembersFromCsv }
export default memberService
