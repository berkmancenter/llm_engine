/**
 * Handles interactive component payloads from Slack (e.g. button clicks).
 * Routes block_actions payloads back into the normal message pipeline so agents
 * can respond to user interactions the same way they respond to messages.
 */

// TODO: implement receiveInteraction
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function receiveInteraction(_payload: unknown): Promise<void> {
  // stub — implementation coming in next commit
}

export default { receiveInteraction }
