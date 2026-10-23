/* eslint-disable security/detect-non-literal-fs-filename */
import fs from 'fs'
import path from 'path'

/**
 * Guard against a new unfiltered read of Message text. Every read of a conversation's messages states an
 * audience (see findMessages in utils/messageVisibility.ts), so the hidden-message rules are applied in one place.
 * A file that reads the Message collection directly has to be listed here, with the reason it is safe: a new
 * entry is a review prompt, not a formality.
 */
const SRC = path.resolve(process.cwd(), 'src')

const RAW_READ =
  /\bMessage\.(find|findOne|findById|findOneAndUpdate|aggregate|distinct|countDocuments|estimatedDocumentCount)\b|path:\s*'messages'|populate\(\s*'messages'/

const ALLOWED: Record<string, string> = {
  'utils/messageVisibility.ts': 'the repo: findMessages and the hide-context lookups themselves',
  'services/moderation.service.ts': 'admin moderation path: hides, unhides and audits messages',
  'services/message.service.ts':
    'REST list, replies, votes: each message goes through viewMessageFor; LLM copies use hiddenMessagesMatch',
  'agents/helpers/getThreadMessages.ts': 'thread reads carry hiddenMessagesMatch(…, model)',
  'services/report.service.ts': 'comment populate carries hiddenMessagesMatch(…, model); every other read is findMessages',
  'models/conversation.model.ts': 'messageCount: a count, no text, with the participant hidden-message match',
  'services/conversationAnalytics.service.ts':
    'counts and timing with the model-audience match (humanMessageMatch); no message text leaves the service',
  'services/topic.service.ts':
    'topic list populates ids and timestamps with the participant match; the archive jobs treat hidden posts as activity',
  'services/conversation.service/index.ts': 'populates ids and visibility flags only',
  'services/experiment.service.ts':
    'experiment copies, which never include hidden messages (duplicateConversationMessages); respond() re-populates with the match',
  'services/user.service.ts': "a user's own messages and reputation votes; no model or report input",
  'services/conceptGraph/index.ts':
    'distinct owner ids for the identity screen (over-inclusive on purpose); text is read through findMessages',
  'services/transcript.service.ts': 'transcript channel only; not hideable',
  'jobs/handlers/transcript.ts': 'transcript channel only; not hideable',
  'jobs/handlers/conversation.ts': 'transcript channel existence and count',
  'jobs/handlers/agent.ts': "the agent's own last message",
  'agents/helpers/transcript.ts': 'transcript channel only; not hideable',
  'agents/eventAssistant/eventAssistant.ts': 'escalation lookup of one message by id (known follow-up)',
  'adapters/slack/index.ts': 'adapter bookkeeping: thread ids, source ids',
  'adapters/zoom.ts': 'adapter bookkeeping: ids and parents only'
}

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })

/** Code lines only: comments are skipped so prose that mentions a call does not trip the scan. */
const rawReads = (file: string): string[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
    .filter(({ line }) => RAW_READ.test(line))
    .map(({ line, n }) => `${n}: ${line}`)

describe('raw Message reads', () => {
  const offenders = sourceFiles(SRC)
    .map((file) => ({ rel: path.relative(SRC, file), hits: rawReads(file) }))
    .filter(({ hits }) => hits.length > 0)

  it('only happen in files on the allowlist', () => {
    const unlisted = offenders.filter(({ rel }) => !ALLOWED[rel])
    expect(unlisted).toEqual([])
  })

  it('has no stale allowlist entries', () => {
    const stale = Object.keys(ALLOWED).filter((rel) => !offenders.some((o) => o.rel === rel))
    expect(stale).toEqual([])
  })

  it('never reads Message directly in the LLM paths that moved to findMessages', () => {
    const moved = [
      'services/conversation.service/lifecycle.ts',
      'agents/vibesAnalyst/capabilities.ts',
      'agents/vibesAnalyst/buildSummary.ts',
      'agents/vibesAnalyst/thread.ts'
    ]
    expect(offenders.filter(({ rel }) => moved.includes(rel))).toEqual([])
  })
})
