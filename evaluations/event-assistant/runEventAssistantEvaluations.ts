/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-console */

import { Client, Example } from 'langsmith'
import mongoose from 'mongoose'
import { execSync } from 'child_process'
import { randomUUID } from 'crypto'

import defaultAgentTypes from '../../src/agents/index.js'
import {
  createEventAssistantConversation,
  createDirectMessage,
  createPublicTopic,
  createUser
} from '../../tests/utils/agentTestHelpers.js'
import { evaluators } from '../../tests/utils/evaluators.js'
import config from '../../src/config/config.js'
import { evaluationTypes, initializeAgentEvaluators } from './eventAssistantConfig.js'
import agenda from '../../src/jobs/index.js'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const verbose = args.includes('--verbose')
const datasetName = args.find((a) => a.startsWith('--dataset='))?.split('=')[1] || 'event-assistant'

// ---------------------------------------------------------------------------
// LangSmith client
// ---------------------------------------------------------------------------

const langsmithClient = new Client()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'nogit'
  }
}

function makeExperimentName() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  return `event-assistant__${ts}__g${getGitSha()}`
}

// ---------------------------------------------------------------------------
// Setup functions
// ---------------------------------------------------------------------------

// Simplified setup - no transcript loading, minimal conversation
async function setupAgentOnce(testConfig: { llmPlatform: string; llmModel: string }) {
  const user = await createUser('Boring Badger')
  const topic = await createPublicTopic()

  const conversation = await createEventAssistantConversation(
    {
      name: 'Event',
      description: 'An event'
    },
    user,
    topic,
    new Date(),
    testConfig.llmPlatform,
    testConfig.llmModel
  )

  const [agent] = conversation.agents
  return { agent, user, conversation }
}

// ---------------------------------------------------------------------------
// Evaluators
// ---------------------------------------------------------------------------

// Default evaluators: Core metrics for response quality and accuracy
const DEFAULT_EVALUATORS = [
  'correctness',
  'hallucination',
  'groundedness',
  'helpfulness',
  'retrievalRelevance',
  'conciseness'
]

async function runEvaluators(
  inputs: string,
  response: any,
  referenceOutputs: string[],
  promptType?: string,
  runId?: string
) {
  const scores: Record<string, number> = {}

  // Determine evaluators based on promptType from example metadata
  let evaluatorsToRun: string[]
  if (promptType && evaluationTypes[promptType]) {
    evaluatorsToRun = evaluationTypes[promptType].evaluators
  } else {
    // Fallback to default evaluators if no promptType specified
    evaluatorsToRun = DEFAULT_EVALUATORS
  }

  for (const evaluatorName of evaluatorsToRun) {
    const evaluator = evaluators[`${evaluatorName}Evaluator`]
    if (!evaluator) {
      console.warn(`Evaluator not found: ${evaluatorName}`)
      continue
    }

    try {
      const result = await evaluator({
        inputs,
        outputs: response.message,
        context: response.context,
        referenceOutputs
      })

      scores[evaluatorName] = result.score

      // Only send to LangSmith if runId is provided
      if (runId) {
        await langsmithClient.createFeedback(runId, evaluatorName, {
          score: result.score,
          comment: result.comment || '',
          feedbackSourceType: 'model'
        })
      }

      if (verbose || !runId) {
        console.log(`  ${evaluatorName}: ${result.score.toFixed(3)}`)
        if (result.comment) console.log(`    ${result.comment}`)
      }
    } catch (err) {
      console.warn(`Error running evaluator ${evaluatorName}: ${err.message}`)
    }
  }

  return scores
}

// ---------------------------------------------------------------------------
// Run a single example
// ---------------------------------------------------------------------------

async function runSingleExample(
  example: Example,
  sharedSetup: { agent: any; user: any; conversation: any },
  experimentName: string
) {
  const runId = randomUUID()

  try {
    console.log(`📝 Running test case ${example.id}`)
    if (verbose) console.log(`\n📝 ${example.id}: ${example.inputs.input}`)

    const msg = await createDirectMessage(example.inputs.input, sharedSetup.user, sharedSetup.conversation)

    // Extract context from metadata if available
    const { context, promptType, topic } = example.metadata ?? {}
    const options: any = {
      ...(context && { context }),
      ...(promptType && { promptType }),
      ...(topic && { topic })
    }
    // NOTE: Latency is reported as the time between createRun and updateRun called with end_time
    await langsmithClient.createRun({
      id: runId,
      name: example.id,
      run_type: 'chain',
      project_name: experimentName,
      inputs: example.inputs,
      reference_example_id: example.id
    })

    const responses = await defaultAgentTypes.eventAssistant.respond.call(
      sharedSetup.agent,
      example.metadata?.conversationHistory,
      msg,
      options
    )
    if (!responses?.length) throw new Error('No response generated')

    const response = responses[0]

    await langsmithClient.updateRun(runId, {
      outputs: { response: response.message },
      end_time: new Date().toISOString()
    })

    const referenceOutputs = [example.outputs?.outputs, example.outputs?.outputs_2, example.outputs?.outputs_3].filter(
      (v): v is string => v !== undefined
    )
    const scores = await runEvaluators(example.inputs.input, response, referenceOutputs, example.metadata?.promptType, runId)

    return { testCaseId: example.id, runId, success: true, output: response.message, scores }
  } catch (err) {
    console.error(`❌ Error in example ${example.id}: ${err.message}`)
    try {
      await langsmithClient.updateRun(runId, {
        error: err.message,
        end_time: new Date().toISOString()
      })
    } catch {
      // Ignore errors when updating run status
    }
    return { testCaseId: example.id, runId, success: false, error: err.message }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🔬 Event Assistant Evaluation Suite')
  console.log('='.repeat(60))

  const experimentName = makeExperimentName()

  console.log(`🧪 Experiment: ${experimentName}`)

  const testConfig = {
    llmPlatform: process.env.TEST_LLM_PLATFORM || defaultAgentTypes.eventAssistant.defaultLLMPlatform,
    llmModel: process.env.TEST_LLM_MODEL || defaultAgentTypes.eventAssistant.defaultLLMModel,
    embeddingsModel: config.embeddings.openAI.realtimeModel
  }

  await initializeAgentEvaluators()

  await mongoose.connect(config.mongoose.url, {
    ...config.mongoose.options,
    autoIndex: false
  })

  // -----------------------------------------------------------------------
  // Load existing dataset
  // -----------------------------------------------------------------------

  const dataset = await langsmithClient.readDataset({ datasetName })
  const examples = langsmithClient.listExamples({ datasetId: dataset.id })

  // -----------------------------------------------------------------------
  // Create experiment (as a project with reference dataset)
  // -----------------------------------------------------------------------

  const experiment = await langsmithClient.createProject({
    projectName: experimentName,
    referenceDatasetId: dataset.id,
    metadata: {
      llmPlatform: testConfig.llmPlatform,
      llmModel: testConfig.llmModel,
      gitSha: getGitSha()
    }
  })

  console.log(`🆔 Experiment ID: ${experiment.id}`)

  const examplesArray: Example[] = []
  for await (const ex of examples) {
    examplesArray.push(ex)
  }

  console.log(`\n📋 Running ${examplesArray.length} dataset examples`)

  // -----------------------------------------------------------------------
  // One-time setup before all runs
  // -----------------------------------------------------------------------

  console.log('🔧 Setting up agent (one-time)...')
  const sharedSetup = await setupAgentOnce(testConfig)
  console.log('✅ Agent setup complete')

  // -----------------------------------------------------------------------
  // Run each example
  // -----------------------------------------------------------------------

  const results: any[] = []

  for (const example of examplesArray) {
    const result = await runSingleExample(example, sharedSetup, experimentName)
    results.push(result)
    if (!verbose) console.log(result.success ? '✓' : '✗')
  }

  console.log('\n\n✅ All runs complete')
  const successful = results.filter((r) => r.success).length
  const failed = results.length - successful
  console.log(`✅ Successful: ${successful}/${results.length}`)
  console.log(`❌ Failed: ${failed}/${results.length}`)

  const workspaceId = dataset.tenant_id || experiment.tenant_id
  console.log(`\n🔗 View Experiment: https://smith.langchain.com/o/${workspaceId}/datasets/${dataset.id}?tab=0`)
  if (failed > 0) process.exit(1)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await agenda.stop()
    await agenda.close()
    await mongoose.disconnect()
  })
