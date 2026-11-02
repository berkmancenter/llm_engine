const STOP_WORDS = /^(study|reading|what|does|would|when|that|this)$/

/** Lowercased content words (4+ letters), minus a few question stop words and anything `ignore` matches. */
export function contentWords(text: string, ignore?: RegExp): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z'-]{4,}/g) ?? []).filter((w) => !STOP_WORDS.test(w) && !(ignore && ignore.test(w)))
  )
}

/**
 * Share of `earlier`'s content words that also appear in `candidate` (0 to 1). Used to tell a
 * genuinely new question from the earlier one reworded; `ignore` drops terms that are expected to
 * repeat, such as the name of the source.
 */
export function contentWordOverlap(earlier: string, candidate: string, ignore?: RegExp): number {
  const earlierWords = contentWords(earlier, ignore)
  if (earlierWords.size === 0) return 0
  const candidateWords = contentWords(candidate, ignore)
  const shared = [...earlierWords].filter((w) => candidateWords.has(w)).length
  return shared / earlierWords.size
}
