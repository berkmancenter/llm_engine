/**
 * ownerIsAdmin is derived per request from the author's current role and deliberately kept off
 * the schema, so toJSON() drops it. Any transport sending a freshly created message re-attaches
 * it through here, or a client sees the label on history but not on the message it just sent.
 */
export default function serializeMessage(message) {
  return {
    ...message.toJSON(),
    ...(message.ownerIsAdmin !== undefined && { ownerIsAdmin: message.ownerIsAdmin })
  }
}
