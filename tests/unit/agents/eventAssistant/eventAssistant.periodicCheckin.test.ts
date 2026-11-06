import { jest } from '@jest/globals'
import path from 'path'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockBuildCheckinResponses = jest.fn<(...args: any[]) => Promise<any>>()

// An absolute path sidesteps any ambiguity in how unstable_mockModule resolves a relative
// specifier — it must match eventAssistant.ts's own resolved import exactly.
const checkinHandlerModulePath = path.resolve(process.cwd(), 'src/agents/eventAssistant/checkinHandler.ts')
jest.unstable_mockModule(checkinHandlerModulePath, () => ({
  default: mockBuildCheckinResponses
}))

const { default: eventAssistant } = await import('../../../../src/agents/eventAssistant/eventAssistant.js')

function buildContext(conversationOverrides: Record<string, unknown> = {}) {
  return {
    agentConfig: {},
    conversation: {
      scheduledTime: new Date(Date.now() + 5 * 60 * 1000),
      preEventMinutes: 15,
      startTime: undefined,
      endTime: undefined,
      draft: false,
      ...conversationOverrides
    }
  }
}

describe('eventAssistant.respond — periodic check-in tick (no userMessage)', () => {
  beforeEach(() => {
    mockBuildCheckinResponses.mockReset().mockResolvedValue([{ message: { type: 'checkin' } }])
  })

  test('skips the proactive check-in while still in the preEvent window', async () => {
    const context = buildContext() // scheduledTime 5 min out, preEventMinutes 15, no startTime -> window open

    const result = await eventAssistant.respond.call(context, { start: new Date(), end: new Date() }, undefined)

    expect(result).toEqual([])
    expect(mockBuildCheckinResponses).not.toHaveBeenCalled()
  })

  test('runs the proactive check-in once the conversation has actually started', async () => {
    const context = buildContext({ startTime: new Date(Date.now() - 2 * 60 * 1000) })
    const conversationHistory = { start: new Date(), end: new Date() }

    const result = await eventAssistant.respond.call(context, conversationHistory, undefined)

    expect(mockBuildCheckinResponses).toHaveBeenCalledWith(conversationHistory)
    expect(result).toEqual([{ message: { type: 'checkin' } }])
  })

  test('runs the proactive check-in when preEventMinutes was never configured', async () => {
    const context = buildContext({ preEventMinutes: undefined })
    const conversationHistory = { start: new Date(), end: new Date() }

    const result = await eventAssistant.respond.call(context, conversationHistory, undefined)

    expect(mockBuildCheckinResponses).toHaveBeenCalledWith(conversationHistory)
    expect(result).toEqual([{ message: { type: 'checkin' } }])
  })
})
