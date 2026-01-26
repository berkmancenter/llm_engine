/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createLLMAsJudge,
  CONCISENESS_PROMPT,
  CORRECTNESS_PROMPT,
  HALLUCINATION_PROMPT,
  RAG_HELPFULNESS_PROMPT,
  RAG_GROUNDEDNESS_PROMPT,
  RAG_RETRIEVAL_RELEVANCE_PROMPT
} from 'openevals'
import { getModelChat, defaultLLMPlatform, defaultLLMModel } from '../../src/agents/helpers/getModelChat.js'
import { LlmPlatforms } from '../../src/types/index.types.js'

// Shared evaluators that will be initialized once
export const evaluators = {
  concisenessEvaluator: null as any,
  correctnessEvaluator: null as any,
  hallucinationEvaluator: null as any,
  helpfulnessEvaluator: null as any,
  groundednessEvaluator: null as any,
  retrievalRelevanceEvaluator: null as any
}

interface CustomPrompts {
  conciseness?: string
  correctness?: string
  hallucination?: string
  helpfulness?: string
  groundedness?: string
  retrievalRelevance?: string
}

export const initializeEvaluators = async (customPrompts: CustomPrompts = {}) => {
  // Always reinitialize if custom prompts are provided, otherwise skip if already initialized
  if (evaluators.concisenessEvaluator && Object.keys(customPrompts).length === 0) {
    return // Already initialized with defaults
  }

  const judge = (await getModelChat(defaultLLMPlatform as LlmPlatforms, defaultLLMModel, {})) as any

  evaluators.concisenessEvaluator = createLLMAsJudge({
    prompt: customPrompts.conciseness || CONCISENESS_PROMPT,
    continuous: true,
    feedbackKey: 'conciseness',
    judge
  })
  evaluators.correctnessEvaluator = createLLMAsJudge({
    prompt: customPrompts.correctness || CORRECTNESS_PROMPT,
    continuous: true,
    feedbackKey: 'correctness',
    judge
  })
  evaluators.hallucinationEvaluator = createLLMAsJudge({
    prompt: customPrompts.hallucination || HALLUCINATION_PROMPT,
    continuous: true,
    feedbackKey: 'hallucination',
    judge
  })
  evaluators.helpfulnessEvaluator = createLLMAsJudge({
    prompt: customPrompts.helpfulness || RAG_HELPFULNESS_PROMPT,
    continuous: true,
    feedbackKey: 'helpfulness',
    judge
  })
  evaluators.groundednessEvaluator = createLLMAsJudge({
    prompt: customPrompts.groundedness || RAG_GROUNDEDNESS_PROMPT,
    continuous: true,
    feedbackKey: 'groundedness',
    judge
  })
  evaluators.retrievalRelevanceEvaluator = createLLMAsJudge({
    prompt: customPrompts.retrievalRelevance || RAG_RETRIEVAL_RELEVANCE_PROMPT,
    continuous: true,
    feedbackKey: 'retrievalRelevance',
    judge
  })
}
