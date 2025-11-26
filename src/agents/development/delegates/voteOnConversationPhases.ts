import { getSinglePromptResponse } from '../../helpers/llmChain.js'
import responseFormatSchemas from '../../helpers/responseFormatSchemas.js'

export default async (llm, topic, delegate, votingTemplate, chunks, numberToPick = 1) => {
  const { personality, interest, pseudonym } = delegate
  const response = (await getSinglePromptResponse(
    llm,
    votingTemplate,
    {
      chunks,
      topic,
      personality,
      interest,
      pseudonym,
      numberToPick
    },
    responseFormatSchemas.votingAnswer
  )) as { results: { chunk: number; reason: string }[] }
  // OpenAI does not support top-level array output schema directly, so the votes array was wrapped in a top-level object
  return response.results
}
