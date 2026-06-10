/* Placeholder — implementation in the next commit. */

export interface SlackHandoffContext {
  slackUserId: string
  slackTeamId: string
  slackChannelId: string
  slackThreadTs: string
}

export type VerifiedSlackHandoff = SlackHandoffContext & { jti: string }

export const mintSlackHandoffToken = (_context: SlackHandoffContext): string => {
  throw new Error('not implemented')
}

export const verifySlackHandoffToken = (_token: string): VerifiedSlackHandoff => {
  throw new Error('not implemented')
}
