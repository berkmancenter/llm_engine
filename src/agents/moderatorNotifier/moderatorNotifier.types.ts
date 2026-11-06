export interface QuestionResultSummary {
  label: string
  count: number
  /** Illustrative verbatim-or-near-verbatim snippets, never attributed. Only meaningful for a
   * synthesized (text) result; a tallied singleChoice option has nothing to illustrate with. */
  examples?: string[]
}

/**
 * A moderator-only synthesis of participant replies to a private prompt message (a warm-up
 * question today; any future private poll-style question reuses this same shape). Kept general
 * on purpose: `questionType` is whatever that prompt's own body.type already is, so a new
 * question kind never needs a parallel naming scheme kept in sync with this one.
 */
export interface QuestionResults {
  questionType: string
  question: string
  format: 'text' | 'singleChoice'
  results: QuestionResultSummary[]
}
