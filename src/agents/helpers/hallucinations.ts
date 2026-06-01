import * as fuzzball from 'fuzzball'
import logger from '../../config/logger.js'

const matchThreshold = 70

interface SourceClaim {
  participant: string
  text: string
}

/**
 * Verifies that every cited {participant, text} pair fuzzy-matches a real participant
 * and that the cited text fuzzy-matches something they actually said.
 * Returns true if all claims are verified, false if any cannot be matched.
 */
export default function filterHallucinations(
  claims: SourceClaim[],
  messages: { pseudonym?: string; body?: unknown; bodyType?: string }[]
): boolean {
  return claims.every((claim) => {
    const participantMessages = messages.filter(
      (m) => fuzzball.ratio(claim.participant, m.pseudonym ?? '') >= matchThreshold
    )

    if (participantMessages.length === 0) {
      logger.info(`Could not find participant match (>=${matchThreshold}%) for cited pseudonym: "${claim.participant}"`)
      return false
    }

    const bestTextMatch = participantMessages.reduce((best, m) => {
      const body = m.bodyType === 'json' ? (m.body as { text?: string })?.text : m.body
      const score = fuzzball.partial_ratio(claim.text, typeof body === 'string' ? body : '')
      return score > (best?.score || 0) ? { score } : best
    }, null as { score: number } | null)

    if (!bestTextMatch || bestTextMatch.score < matchThreshold) {
      logger.info(
        `Could not find text match (>=${matchThreshold}%) for cited text: "${claim.text}" from "${
          claim.participant
        }" (best: ${bestTextMatch?.score || 0}%)`
      )
      return false
    }

    return true
  })
}
