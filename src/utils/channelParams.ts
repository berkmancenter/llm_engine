import { ChannelCredential } from '../types/index.types.js'

/**
 * Reads the `channel=<name>,<passcode>` pairs off a request's query string.
 *
 * Event links carry access this way: the URL repeats `channel=` once per channel the holder
 * may open, and the passcode in each pair is what grants that access. Express gives back a
 * bare string when the parameter appears once and an array when it repeats, so both shapes
 * collapse to a list here.
 *
 * @param {unknown} channel The raw `req.query.channel` value.
 * @returns {ChannelCredential[]} One entry per pair, empty when the query string names none.
 */
const parseChannelParams = (channel: unknown): ChannelCredential[] => {
  if (!channel) return []

  const pairs = Array.isArray(channel) ? channel : [channel]
  return pairs.map((pair) => {
    const [name, passcode] = String(pair)
      .split(',')
      .map((part) => part.trim())
    return { name, passcode }
  })
}

export default parseChannelParams
