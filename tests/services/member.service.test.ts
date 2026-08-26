import fs from 'fs'
import path from 'path'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import memberService from '../../src/services/member.service.js'
import { ConversationMembership } from '../../src/models/index.js'
import { insertConversations, conversationCommunityRoom, conversationOne } from '../fixtures/conversation.fixture.js'
import { insertUsers, admin } from '../fixtures/user.fixture.js'

setupIntTest()

// eslint-disable-next-line security/detect-non-literal-fs-filename
const readCsv = (name: string) => fs.readFileSync(path.join('tests/fixtures/csv', name))

const ALL_EMAILS = [
  'ada.lovelace@example.com',
  'grace.hopper@example.com',
  'alan.turing@example.com',
  'katherine.johnson@example.com',
  'margaret.hamilton@example.com'
].sort()

describe('memberService.importMembersFromCsv', () => {
  beforeEach(async () => {
    await insertUsers([admin])
    await insertConversations([conversationCommunityRoom])
    await ConversationMembership.syncIndexes()
  })

  test('imports a clean file, creating one record per row', async () => {
    const result = await memberService.importMembersFromCsv(
      conversationCommunityRoom._id.toString(),
      readCsv('members-clean.csv'),
      admin
    )
    expect(result).toMatchObject({ added: 5, updated: 0, skipped: 0, failed: 0, errors: [] })

    const stored = await ConversationMembership.find({ conversation: conversationCommunityRoom._id }).lean()
    expect(stored.map((m) => m.email).sort()).toEqual(ALL_EMAILS)
  })

  test('maps headers that vary in casing, spacing, punctuation, and wording to the same fields', async () => {
    const result = await memberService.importMembersFromCsv(
      conversationCommunityRoom._id.toString(),
      readCsv('members-messy-headers.csv'),
      admin
    )
    expect(result).toMatchObject({ added: 5, failed: 0 })

    const ada = await ConversationMembership.findOne({
      conversation: conversationCommunityRoom._id,
      email: 'ada.lovelace@example.com'
    }).lean()
    expect(ada?.name).toBe('Ada Lovelace')
    expect(ada?.bio).toBe('Mathematician and writer.')
  })

  test(
    'collapses an in-file duplicate email (later row wins), sanitizes control characters, leaves a ' +
      'formula-shaped name unmutated at import, and reports the invalid-email row without leaking its value',
    async () => {
      const result = await memberService.importMembersFromCsv(
        conversationCommunityRoom._id.toString(),
        readCsv('members-duplicates-and-dirty.csv'),
        admin
      )
      // 5 data rows: 1 duplicate email collapses, 1 invalid email fails -> 3 added
      expect(result.added).toBe(3)
      expect(result.skipped).toBe(1)
      expect(result.failed).toBe(1)
      expect(result.errors).toEqual([{ row: 6, column: 'email', message: 'must be a valid email address' }])
      expect(JSON.stringify(result.errors)).not.toContain('not-an-email')

      const ada = await ConversationMembership.findOne({
        conversation: conversationCommunityRoom._id,
        email: 'ada.lovelace@example.com'
      }).lean()
      // the later of the two duplicate rows wins
      expect(ada?.bio).toBe('Mathematician and writer.')

      const bob = await ConversationMembership.findOne({
        conversation: conversationCommunityRoom._id,
        email: 'bob.sanitized@example.com'
      }).lean()
      expect(bob?.name).toBe('Bob Sanitized') // embedded control character stripped

      const injected = await ConversationMembership.findOne({
        conversation: conversationCommunityRoom._id,
        email: 'formula.name@example.com'
      }).lean()
      // stored as-is: the formula-injection guard only applies when re-exporting, not on import
      expect(injected?.name).toBe('=SUM(A1:A9) Injection')
    }
  )

  test('re-importing updates existing records instead of duplicating, and never resets inviteState/status', async () => {
    await memberService.importMembersFromCsv(conversationCommunityRoom._id.toString(), readCsv('members-clean.csv'), admin)
    // simulate a later invite/moderation step having advanced this member's state
    await ConversationMembership.updateOne(
      { conversation: conversationCommunityRoom._id, email: 'ada.lovelace@example.com' },
      { $set: { inviteState: 'invited', status: 'removed' } }
    )

    const result = await memberService.importMembersFromCsv(
      conversationCommunityRoom._id.toString(),
      readCsv('members-reimport-update.csv'),
      admin
    )
    expect(result).toMatchObject({ added: 0, updated: 5 })
    expect(await ConversationMembership.countDocuments({ conversation: conversationCommunityRoom._id })).toBe(5)

    const ada = await ConversationMembership.findOne({
      conversation: conversationCommunityRoom._id,
      email: 'ada.lovelace@example.com'
    }).lean()
    expect(ada?.bio).toBe('Updated: pioneering computer programmer.') // mutable field updated
    expect(ada?.inviteState).toBe('invited') // never re-invited / reset by re-import
    expect(ada?.status).toBe('removed') // never revived by re-import
  })

  test('a member missing from a later import is left in place, not removed', async () => {
    await memberService.importMembersFromCsv(conversationCommunityRoom._id.toString(), readCsv('members-clean.csv'), admin)
    await ConversationMembership.create({
      conversation: conversationCommunityRoom._id,
      email: 'manual.add@example.com',
      name: 'Manually Added'
    })

    await memberService.importMembersFromCsv(conversationCommunityRoom._id.toString(), readCsv('members-clean.csv'), admin)

    const manual = await ConversationMembership.findOne({
      conversation: conversationCommunityRoom._id,
      email: 'manual.add@example.com'
    }).lean()
    expect(manual).not.toBeNull()
    expect(manual?.status).toBe('active')
  })

  test('rejects a conversation type that is not eligible for member import', async () => {
    await expect(
      memberService.importMembersFromCsv(conversationOne._id.toString(), readCsv('members-clean.csv'), admin)
    ).rejects.toMatchObject({ statusCode: httpStatus.BAD_REQUEST })
  })

  test('rejects a conversation that does not exist', async () => {
    await expect(
      memberService.importMembersFromCsv(new mongoose.Types.ObjectId().toString(), readCsv('members-clean.csv'), admin)
    ).rejects.toMatchObject({ statusCode: httpStatus.NOT_FOUND })
  })

  test('auto-detects a semicolon delimiter (common in European-locale Excel exports)', async () => {
    const result = await memberService.importMembersFromCsv(
      conversationCommunityRoom._id.toString(),
      readCsv('members-semicolon-delimited.csv'),
      admin
    )
    expect(result).toMatchObject({ added: 2, failed: 0 })
    const ada = await ConversationMembership.findOne({
      conversation: conversationCommunityRoom._id,
      email: 'ada.lovelace@example.com'
    }).lean()
    expect(ada?.interests).toBe('Computing, Mathematics')
  })

  test('preserves a comma embedded in a properly quoted field', async () => {
    const result = await memberService.importMembersFromCsv(
      conversationCommunityRoom._id.toString(),
      readCsv('members-quoted-commas.csv'),
      admin
    )
    expect(result).toMatchObject({ added: 2, failed: 0 })
    const ada = await ConversationMembership.findOne({
      conversation: conversationCommunityRoom._id,
      email: 'ada.lovelace@example.com'
    }).lean()
    expect(ada?.bio).toBe('Mathematician, writer, and analyst of the Analytical Engine')
  })

  test('rejects a file that is not valid UTF-8 instead of silently corrupting accented names', async () => {
    // "Jos\xe9" (Windows-1252/Latin-1 for "José") is not valid UTF-8: 0xe9 alone is a
    // continuation byte with no lead byte.
    const invalidUtf8 = Buffer.concat([
      Buffer.from('First Name,Last Name,Email,Bio,Interests\n', 'utf8'),
      Buffer.from([0x4a, 0x6f, 0x73, 0xe9]),
      Buffer.from(',Garcia,jose.garcia@example.com,Bio,Interests\n', 'utf8')
    ])
    await expect(
      memberService.importMembersFromCsv(conversationCommunityRoom._id.toString(), invalidUtf8, admin)
    ).rejects.toMatchObject({ statusCode: httpStatus.BAD_REQUEST })
    expect(await ConversationMembership.countDocuments({ conversation: conversationCommunityRoom._id })).toBe(0)
  })

  test('imports a genuinely UTF-8 accented name correctly', async () => {
    const csv = Buffer.from(
      'First Name,Last Name,Email,Bio,Interests\nJosé,García,jose.garcia@example.com,Bio,Interests\n',
      'utf8'
    )
    const result = await memberService.importMembersFromCsv(conversationCommunityRoom._id.toString(), csv, admin)
    expect(result).toMatchObject({ added: 1, failed: 0 })
    const jose = await ConversationMembership.findOne({
      conversation: conversationCommunityRoom._id,
      email: 'jose.garcia@example.com'
    }).lean()
    expect(jose?.name).toBe('José García')
  })

  test(
    'rejects a row with more columns than the header (risk of a silently truncated value), ' +
      'but tolerates one with fewer (a harmless omitted trailing column)',
    async () => {
      const csv = Buffer.from(
        'First Name,Last Name,Email,Bio,Interests\n' +
          // too many fields: an unescaped comma inside what was meant to be one Bio value
          'Ada,Lovelace,ada.lovelace@example.com,Loves math, science,Math\n' +
          // too few fields: Bio/Interests just omitted, otherwise a complete, valid row
          'Grace,Hopper,grace.hopper@example.com\n',
        'utf8'
      )
      const result = await memberService.importMembersFromCsv(conversationCommunityRoom._id.toString(), csv, admin)
      expect(result.added).toBe(1)
      expect(result.failed).toBe(1)
      expect(result.errors).toEqual([{ row: 2, column: '(row)', message: 'row has more columns than the header row' }])

      const grace = await ConversationMembership.findOne({
        conversation: conversationCommunityRoom._id,
        email: 'grace.hopper@example.com'
      }).lean()
      expect(grace?.name).toBe('Grace Hopper')
      expect(grace?.bio).toBe('')

      const ada = await ConversationMembership.findOne({
        conversation: conversationCommunityRoom._id,
        email: 'ada.lovelace@example.com'
      }).lean()
      expect(ada).toBeNull() // the truncation-risk row was rejected outright, not imported partially
    }
  )

  test('rejects a file with a header row but no data rows', async () => {
    const csv = Buffer.from('First Name,Last Name,Email,Bio,Interests\n', 'utf8')
    await expect(
      memberService.importMembersFromCsv(conversationCommunityRoom._id.toString(), csv, admin)
    ).rejects.toMatchObject({ statusCode: httpStatus.BAD_REQUEST })
  })
})
