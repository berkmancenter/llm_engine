import renderArchiveDraftCard, {
  archiveDraftCardText
} from '../../../../../src/adapters/slack/blocks/archive/archiveDraftCard.js'

const data = { title: 'Public event', date: '2026-10-14', draftId: `event-${'e'.repeat(64)}` }

test('card shows the event title, date, draft ID and a review hint', () => {
  const json = JSON.stringify(renderArchiveDraftCard(data))
  expect(json).toContain('Public event')
  expect(json).toContain('2026-10-14')
  expect(json).toContain(data.draftId)
  expect(json).toContain('curator review in the archive inbox')
  expect(archiveDraftCardText(data)).toContain(data.draftId)
})

test('card carries no summary, participants or other draft content', () => {
  const input = { ...data, summary: 'SECRET SUMMARY TEXT', participants: ['Speaker Name'] }
  const json = JSON.stringify(renderArchiveDraftCard(input)) + archiveDraftCardText(input)
  expect(json).not.toContain('SECRET SUMMARY TEXT')
  expect(json).not.toContain('Speaker Name')
})

test('titles are escaped for mrkdwn and truncated', () => {
  const json = JSON.stringify(renderArchiveDraftCard({ ...data, title: `<!channel> & ${'x'.repeat(300)}` }))
  expect(json).not.toContain('<!channel>')
  expect(json).toContain('&lt;!channel&gt; &amp;')
  expect(json).not.toContain('x'.repeat(200))
})

test('the plain-text fallback is escaped too, since Slack parses it as mrkdwn in notifications', () => {
  const text = archiveDraftCardText({ ...data, title: '<!channel> & x', date: '<@U123>' })
  expect(text).toContain('&lt;!channel&gt; &amp;')
  expect(text).not.toContain('<!channel>')
  expect(text).toContain('&lt;@U123&gt;')
})
