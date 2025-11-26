import * as fuzzball from 'fuzzball'
import logger from '../../config/logger.js'

const matchThreshold = 70

export default async function filterHallucinations(responses, messages) {
  return responses.filter((response) => {
    const hallucinated = response.comments.some((comment) => {
      // Check if we can find a user match at threshold % or higher
      const bestUserMatch = messages.reduce((best, m) => {
        const score = fuzzball.ratio(comment.user, m.pseudonym)
        return score > (best?.score || 0) ? { message: m, score } : best
      }, null)

      if (!bestUserMatch || bestUserMatch.score < matchThreshold) {
        logger.info(
          `Could not find user match (>=${matchThreshold}%) for: "${comment.user}" (best: ${bestUserMatch?.score || 0}%)`
        )
        return true // Mark as hallucinated
      }

      // Check if we can find a text match at threshold % or higher
      const bestTextMatch = messages.reduce((best, m) => {
        const score = fuzzball.partial_ratio(comment.text, m.bodyType === 'json' ? m.body.text : m.body)
        return score > (best?.score || 0) ? { message: m, score } : best
      }, null)

      if (!bestTextMatch || bestTextMatch.score < matchThreshold) {
        logger.info(
          `Could not find text match (>=${matchThreshold}%) for: "${comment.text}" (best: ${bestTextMatch?.score || 0}%)`
        )
        return true // Mark as hallucinated
      }
      return false // Not hallucinated
    })
    if (hallucinated) {
      logger.info(`Hallucinated comment: ${JSON.stringify(response, null, 2)}`)
    }
    return !hallucinated
  })
}
