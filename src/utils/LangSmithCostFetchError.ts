/**
 * A LangSmith cost query that failed, as opposed to one that found nothing (null). The
 * difference matters to any caller that adds windowed reads onto a stored running total:
 * recording a failure as an empty window would advance the window past runs that were
 * never counted, and nothing re-reads them later.
 */
export default class LangSmithCostFetchError extends Error {
  readonly conversationId: string

  constructor(conversationId: string, cause: unknown) {
    super(`LangSmith cost fetch failed for conversation ${conversationId}`, { cause })
    this.name = 'LangSmithCostFetchError'
    this.conversationId = conversationId
  }
}
