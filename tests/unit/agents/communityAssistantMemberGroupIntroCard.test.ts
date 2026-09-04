import renderMemberGroupIntroCard from '../../../src/adapters/slack/blocks/communityAssistant/memberGroupIntroCard.js'

describe('renderMemberGroupIntroCard', () => {
  const text = 'Priya and Marcus both spent years trying to fix the same broken systems from different angles.'

  it('returns divider, header, section, context blocks', () => {
    const blocks = renderMemberGroupIntroCard({ text })
    expect(blocks).toHaveLength(4)
    expect(blocks[0].type).toBe('divider')
    expect(blocks[1].type).toBe('header')
    expect(blocks[2].type).toBe('section')
    expect(blocks[3].type).toBe('context')
  })

  it('header contains "Member Spotlight"', () => {
    const blocks = renderMemberGroupIntroCard({ text })
    const header = blocks[1] as { type: string; text: { text: string } }
    expect(header.text.text).toContain('Member Spotlight')
  })

  it('section contains the LLM-generated text as mrkdwn', () => {
    const blocks = renderMemberGroupIntroCard({ text })
    const section = blocks[2] as { type: string; text: { type: string; text: string } }
    expect(section.text.type).toBe('mrkdwn')
    expect(section.text.text).toBe(text)
  })
})
