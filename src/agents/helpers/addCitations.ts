// defaults to use shortCitation
export default async function addCitations(answer, citations, retrievedDocs, useFullCitation = false) {
  // Filter and format citations based on their index
  const retrievedCitationDocs = citations.map((index) => retrievedDocs[index]).filter((doc) => doc) // ensure valid documents

  // Group citations by source
  const citationsBySource = {}
  retrievedCitationDocs.forEach((doc) => {
    const { metadata } = doc

    const source = (useFullCitation && metadata?.citation) || metadata?.shortCitation || metadata?.source || 'Unknown Source'

    if (!citationsBySource[source]) {
      citationsBySource[source] = {
        source,
        pages: new Set()
      }
    }

    // Add page number if it exists
    if (metadata?.pageNumber) {
      citationsBySource[source].pages.add(parseInt(metadata.pageNumber, 10))
    }
  })

  // Format the grouped citations
  const formattedCitations = Object.values(citationsBySource).map((citation: { source: string; pages: Set<number> }) => {
    const pagesArray = Array.from(citation.pages).sort((a, b) => a - b)
    if (pagesArray.length === 0) {
      return citation.source
    }
    if (pagesArray.length === 1) {
      return `${citation.source}, p. ${pagesArray[0]}`
    }
    return `${citation.source}, pp. ${pagesArray.join(', ')}`
  })

  // Append formatted citations as numbered references
  return `${answer}\n\n${formattedCitations.map((cite, idx) => `[${idx + 1}] (${cite})`).join('\n')}`
}
