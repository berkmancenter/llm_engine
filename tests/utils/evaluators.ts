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
import * as ls from 'langsmith/jest'
import { getOpenAIChat } from '../../src/agents/helpers/getModelChat.js'

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

  evaluators.concisenessEvaluator = createLLMAsJudge({
    prompt: customPrompts.conciseness || CONCISENESS_PROMPT,
    continuous: true,
    feedbackKey: 'conciseness',
    judge: await getOpenAIChat('gpt-4o-mini', {})
  })
  evaluators.correctnessEvaluator = createLLMAsJudge({
    prompt: customPrompts.correctness || CORRECTNESS_PROMPT,
    continuous: true,
    feedbackKey: 'correctness',
    judge: await getOpenAIChat('gpt-4o-mini', {})
  })
  evaluators.hallucinationEvaluator = createLLMAsJudge({
    prompt: customPrompts.hallucination || HALLUCINATION_PROMPT,
    continuous: true,
    feedbackKey: 'hallucination',
    judge: await getOpenAIChat('gpt-4o-mini', {})
  })
  evaluators.helpfulnessEvaluator = createLLMAsJudge({
    prompt: customPrompts.helpfulness || RAG_HELPFULNESS_PROMPT,
    continuous: true,
    feedbackKey: 'helpfulness',
    judge: await getOpenAIChat('gpt-4o-mini', {})
  })
  evaluators.groundednessEvaluator = createLLMAsJudge({
    prompt: customPrompts.groundedness || RAG_GROUNDEDNESS_PROMPT,
    continuous: true,
    feedbackKey: 'groundedness',
    judge: await getOpenAIChat('gpt-4o-mini', {})
  })
  evaluators.retrievalRelevanceEvaluator = createLLMAsJudge({
    prompt: customPrompts.retrievalRelevance || RAG_RETRIEVAL_RELEVANCE_PROMPT,
    continuous: true,
    feedbackKey: 'retrievalRelevance',
    judge: await getOpenAIChat('gpt-4o-mini', {})
  })
}

export const logAndCheckEvaluationResult = (result) => {
  ls.logFeedback({
    key: result.key,
    score: result.score,
    comment: result.comment
  })
  // TODO reenable when all tests meet this threshold
  // expect(result.score).toBeGreaterThanOrEqual(0.6)
}

/**
 * Evaluate response where output answers the question of what happened in a certain time interval,
 * therefore helpfulness, retrieval relevance, and conciseness
 * @param inputs
 * @param response
 * @param referenceOutputs
 */
async function evaluateCorrectness(inputs, response, referenceOutputs) {
  const correctnessResult = await evaluators.correctnessEvaluator({
    inputs,
    outputs: response.message,
    context: response.context,
    referenceOutputs
  })
  logAndCheckEvaluationResult(correctnessResult)
}

async function evaluateConciseness(inputs, response, referenceOutputs) {
  const concisenessResult = await evaluators.concisenessEvaluator({
    inputs,
    outputs: response.message,
    context: response.context,
    referenceOutputs
  })
  logAndCheckEvaluationResult(concisenessResult)
}

async function evaluateHallucination(inputs, response) {
  const hallucinationResult = await evaluators.hallucinationEvaluator({
    inputs,
    outputs: response.message,
    context: response.context,
    referenceOutputs: ''
  })
  logAndCheckEvaluationResult(hallucinationResult)
}

async function evaluateHelpfulness(inputs, response) {
  const helpfulnessResult = await evaluators.helpfulnessEvaluator({
    inputs,
    outputs: response.message
  })
  logAndCheckEvaluationResult(helpfulnessResult)
}

async function evaluateGroundedness(response) {
  const groundednessResult = await evaluators.groundednessEvaluator({
    context: response.context,
    outputs: response.message
  })
  logAndCheckEvaluationResult(groundednessResult)
}

/**
 * Evaluate response where output directly answers questions posed in input, so all traditional evaluators are relevent
 * @param inputs
 * @param response
 * @param referenceOutputs
 */
async function evaluateRetrievalRelevance(inputs, response) {
  const retrievalRelevanceResult = await evaluators.retrievalRelevanceEvaluator({
    context: response.context,
    inputs
  })
  logAndCheckEvaluationResult(retrievalRelevanceResult)
}

export const evaluateTimeWindowResponse = async (inputs, response, referenceOutputs?) => {
  await evaluateCorrectness(inputs, response, referenceOutputs)
  await evaluateHallucination(inputs, response)
  await evaluateGroundedness(response)
}

export const evaluateSemanticResponse = async (inputs, response, referenceOutputs?) => {
  await evaluateTimeWindowResponse(inputs, response, referenceOutputs)
  await evaluateHelpfulness(inputs, response)
  await evaluateRetrievalRelevance(inputs, response)
  await evaluateConciseness(inputs, response, referenceOutputs)
}

/**
 * Evaluate response where helpfulness is not a relevant evaluator because output
 * does not directly address input
 * @param inputs
 * @param response
 * @param referenceOutputs
 */
export const evaluateSynthesisResponse = async (inputs, response, referenceOutputs?) => {
  await evaluateTimeWindowResponse(inputs, response, referenceOutputs)
  await evaluateRetrievalRelevance(inputs, response)
  await evaluateConciseness(inputs, response, referenceOutputs)
}

export const evaluateNonContextualResult = async (inputs, response, referenceOutputs?) => {
  // groundedness and retrieval relevance not helpful here b/c we are asking it to go off-context
  await evaluateCorrectness(inputs, response, referenceOutputs)
  await evaluateHallucination(inputs, response)
  await evaluateHelpfulness(inputs, response)
  await evaluateConciseness(inputs, response, referenceOutputs)
}
