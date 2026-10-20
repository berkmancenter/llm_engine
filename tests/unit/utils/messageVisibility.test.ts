import {
  inHideableChannel,
  isMessageHidden,
  viewMessageFor,
  renderMessageView,
  toStub,
  hiddenDisplay,
  emptyHideContext,
  HideContext,
  HiddenDisplay,
  MessageViewKind
} from '../../../src/utils/messageVisibility.js'

const ADMIN = { id: 'admin-1', isAdmin: true }
const AUTHOR = { id: 'author-1', isAdmin: false }
const OTHER = { id: 'other-1', isAdmin: false }

const ctxFor = (display: HiddenDisplay, over: Partial<HideContext> = {}): HideContext => ({
  ...emptyHideContext(display),
  ...over
})

describe('hiddenDisplay policy', () => {
  it('defaults to omit', () => {
    expect(hiddenDisplay).toBe('omit')
  })
})

describe('viewMessageFor', () => {
  const chat = ['chat']
  const plain = { _id: 'm1', owner: 'author-1', channels: chat }
  const singleHide = { _id: 'm2', owner: 'author-1', hiddenByAdmin: true, channels: chat }
  const byHiddenAuthor = { _id: 'm3', owner: 'author-1', channels: chat }
  const replyToHidden = { _id: 'm4', owner: 'third-1', parentMessage: 'm2', channels: chat }
  const ownReplyToHidden = { _id: 'm5', owner: 'author-1', parentMessage: 'm2', channels: chat }

  const authorHiddenCtx = (display: HiddenDisplay) => ctxFor(display, { hiddenAuthors: new Set(['author-1']) })
  const cascadeCtx = (display: HiddenDisplay) => ctxFor(display, { hiddenIds: new Set(['m2', 'm4', 'm5']) })

  // [case, message, ctx builder, viewer, expected in omit mode, expected in placeholder mode]
  const table: Array<[string, object, (d: HiddenDisplay) => HideContext, typeof ADMIN, MessageViewKind, MessageViewKind]> = [
    ['not hidden: admin', plain, ctxFor, ADMIN, 'full', 'full'],
    ['not hidden: author', plain, ctxFor, AUTHOR, 'full', 'full'],
    ['not hidden: other', plain, ctxFor, OTHER, 'full', 'full'],
    ['single hide: admin', singleHide, cascadeCtx, ADMIN, 'flagged', 'flagged'],
    ['single hide: author', singleHide, cascadeCtx, AUTHOR, 'full', 'full'],
    ['single hide: other', singleHide, cascadeCtx, OTHER, 'omit', 'stub'],
    ['hidden author: admin', byHiddenAuthor, authorHiddenCtx, ADMIN, 'flagged', 'flagged'],
    ['hidden author: author', byHiddenAuthor, authorHiddenCtx, AUTHOR, 'full', 'full'],
    ['hidden author: other', byHiddenAuthor, authorHiddenCtx, OTHER, 'omit', 'stub'],
    ['reply cascade: admin', replyToHidden, cascadeCtx, ADMIN, 'flagged', 'flagged'],
    ['reply cascade: reply author', ownReplyToHidden, cascadeCtx, AUTHOR, 'full', 'full'],
    ['reply cascade: other participant', replyToHidden, cascadeCtx, OTHER, 'omit', 'stub'],
    ['reply cascade: parent author sees others replies hidden', replyToHidden, cascadeCtx, AUTHOR, 'omit', 'stub']
  ]

  it.each(table)('%s', (_name, message, ctxBuilder, viewer, omitKind, placeholderKind) => {
    expect(viewMessageFor(message, viewer, ctxBuilder('omit'))).toBe(omitKind)
    expect(viewMessageFor(message, viewer, ctxBuilder('placeholder'))).toBe(placeholderKind)
  })

  it('treats a reply to a hidden parent as hidden even when the id set lacks the reply itself', () => {
    const ctx = ctxFor('omit', { hiddenIds: new Set(['m2']) })
    expect(viewMessageFor(replyToHidden, OTHER, ctx)).toBe('omit')
  })

  it('accepts populated owners and serialized ids', () => {
    const populated = { id: 'm9', owner: { _id: 'author-1' }, hiddenByAdmin: true, channels: ['chat'] }
    expect(viewMessageFor(populated, AUTHOR, ctxFor('omit'))).toBe('full')
    expect(viewMessageFor(populated, OTHER, ctxFor('omit'))).toBe('omit')
  })

  it('does not treat an anonymous viewer as the author of an ownerless message', () => {
    const ownerless = { _id: 'm6', hiddenByAdmin: true, channels: ['chat'] }
    expect(viewMessageFor(ownerless, { isAdmin: false }, ctxFor('omit'))).toBe('omit')
  })
})

describe('scope: the chat channel only', () => {
  const everything = ctxFor('omit', { hiddenAuthors: new Set(['author-1']), hiddenIds: new Set(['p1']) })

  it.each([
    ['an assistant channel', ['assistant']],
    ['a direct channel', ['direct-author-1-agent-1']],
    ['no channel', []],
    ['an absent channels field', undefined]
  ])('never hides a message in %s, whatever hides its author, flags or parent', (_name, channels) => {
    const messages = [
      { _id: 'n1', owner: 'author-1', channels },
      { _id: 'n2', owner: 'other-1', hiddenByAdmin: true, channels },
      { _id: 'n3', owner: 'other-1', parentMessage: 'p1', channels },
      { _id: 'p1', owner: 'other-1', channels }
    ]
    for (const message of messages) {
      expect(isMessageHidden(message, everything)).toBe(false)
      expect(viewMessageFor(message, OTHER, everything)).toBe('full')
      expect(viewMessageFor(message, ADMIN, everything)).toBe('full')
    }
  })

  it('hides a message that is in chat among other channels', () => {
    expect(viewMessageFor({ _id: 'n4', owner: 'author-1', channels: ['assistant', 'chat'] }, OTHER, everything)).toBe('omit')
  })

  it('recognises chat given as names or as channel objects', () => {
    expect(inHideableChannel({ channels: ['chat'] })).toBe(true)
    expect(inHideableChannel({ channels: [{ name: 'chat' }] })).toBe(true)
    expect(inHideableChannel({ channels: [{ name: 'assistant' }] })).toBe(false)
    expect(inHideableChannel({})).toBe(false)
  })
})

describe('renderMessageView', () => {
  const serialized = {
    id: 'm1',
    body: 'secret',
    owner: 'author-1',
    pseudonym: 'Bold Aardvark',
    pseudonymId: 'p1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    parentMessage: 'm0'
  }

  it('returns the message as is for full', () => {
    expect(renderMessageView(serialized, 'full')).toBe(serialized)
  })

  it('adds hidden: true for flagged', () => {
    expect(renderMessageView(serialized, 'flagged')).toEqual({ ...serialized, hidden: true })
  })

  it('returns null for omit', () => {
    expect(renderMessageView(serialized, 'omit')).toBeNull()
  })

  it('returns exactly the stub shape for stub, with no author, pseudonym or body', () => {
    const stub = renderMessageView(serialized, 'stub')
    expect(stub).toEqual({
      id: 'm1',
      createdAt: serialized.createdAt,
      parentMessage: 'm0',
      hidden: true,
      body: null
    })
    expect(Object.keys(stub).sort()).toEqual(['body', 'createdAt', 'hidden', 'id', 'parentMessage'])
    expect(JSON.stringify(stub)).not.toContain('secret')
    expect(JSON.stringify(stub)).not.toContain('Bold Aardvark')
  })

  it('builds a stub from a raw document shape too', () => {
    expect(toStub({ _id: 'm7', createdAt: 1 })).toEqual({
      id: 'm7',
      createdAt: 1,
      parentMessage: undefined,
      hidden: true,
      body: null
    })
  })
})
