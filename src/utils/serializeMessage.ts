/**
 * ownerIsAdmin is derived per request from the author's current role and deliberately kept off
 * the schema, so toJSON() drops it. Any transport sending a freshly created message re-attaches
 * it through here, or a client sees the label on history but not on the message it just sent.
 */
/* Clients compare `owner` to their own user id, so it is always the plain id string: assigning a
   User document to the ref path (createMessage does) makes toJSON emit the whole populated user. */
export const ownerIdOf = (owner) =>
  owner === undefined || owner === null ? undefined : (owner._id ?? owner.id ?? owner).toString()

export default function serializeMessage(message) {
  const json = message.toJSON()
  return {
    ...json,
    ...(json.owner !== undefined && json.owner !== null && { owner: ownerIdOf(json.owner) }),
    ...(message.ownerIsAdmin !== undefined && { ownerIsAdmin: message.ownerIsAdmin })
  }
}
