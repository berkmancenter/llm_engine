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
  createMessage,
  createPublicTopic,
  createUser,
  loadTestTranscript,
  prepareMessagesForAgent
} from '../../tests/utils/agentTestHelpers.js'
import getConversationHistory from '../../src/agents/helpers/getConversationHistory.js'
import config from '../../src/config/config.js'
import { evaluators, EVALUATOR_NAMES, initializeAgentEvaluators, makeJudgeContext } from './behaviorPolicyConfig.js'
import { TEMPLATES, ConversationTemplate } from '../templates.js'
import agenda from '../../src/jobs/index.js'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const verbose = args.includes('--verbose')
const datasetName = args.find((a) => a.startsWith('--dataset='))?.split('=')[1] || 'qa-behavior'
const exampleFilter = args.find((a) => a.startsWith('--example='))?.split('=')[1]
const dimensionFilter = args.find((a) => a.startsWith('--dimension='))?.split('=')[1]

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
  return `qa-behavior__${ts}__g${getGitSha()}`
}

// ---------------------------------------------------------------------------
// Agent setup
// ---------------------------------------------------------------------------

async function setupAgent(
  testConfig: { llmPlatform: string; llmModel: string },
  template: ConversationTemplate,
  inputs: any,
  startTime: Date
) {
  const user = await createUser('Curious Participant')
  const topic = await createPublicTopic()

  const conversation = await createEventAssistantConversation(
    {
      name: inputs.eventName ?? 'Event',
      description: inputs.eventDescription ?? '',
      presenters: inputs.presenters ?? []
    },
    user,
    topic,
    startTime,
    testConfig.llmPlatform,
    testConfig.llmModel
  )

  // Apply template — overwrite the neutral policy set by createEventAssistantConversation
  conversation.behaviorPolicy = template.behaviorPolicy
  conversation.goals = template.goals
  await conversation.save()

  const [agent] = conversation.agents
  return { agent, conversation, user }
}

// ---------------------------------------------------------------------------
// Build conversation state
// ---------------------------------------------------------------------------

async function buildConversationState(setup: { agent: any; conversation: any; user: any }, inputs: any, startTime: Date) {
  const { agent, conversation, user } = setup
  const getTime = (offsetSeconds: number) => new Date(startTime.getTime() + offsetSeconds * 1000)

  const messages: any[] = []

  if (inputs.transcriptMessages?.length > 0) {
    const toMMSS = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
    const transcriptText = inputs.transcriptMessages
      .map((m: any) => `${toMMSS(m.offsetSeconds)} | ${m.speaker}: ${m.text}`)
      .join('\n')
    await loadTestTranscript(conversation, transcriptText, true, '|')
  }

  for (const m of inputs.chatMessages ?? []) {
    messages.push(await createMessage(m.text, user, conversation, ['chat'], getTime(m.offsetSeconds)))
  }

  await prepareMessagesForAgent(messages, conversation, agent)

  const directChannelNames = agent.conversation.channels.filter((c: any) => c.direct).map((c: any) => c.name)
  return getConversationHistory(
    agent.conversation.messages,
    {
      count: 100,
      channels: ['chat'],
      directMessages: true,
      endTime: new Date(startTime.getTime() + (inputs.endTimeSeconds ?? 300) * 1000)
    },
    null,
    directChannelNames
  )
}

// ---------------------------------------------------------------------------
// Run evaluators
// ---------------------------------------------------------------------------

async function runEvaluators(inputs: any, outputMessage: string, context: string, runId: string) {
  const scores: Record<string, number> = {}

  for (const name of EVALUATOR_NAMES) {
    const evaluator = evaluators[`${name}Evaluator`]
    if (!evaluator) {
      console.warn(`Evaluator not found: ${name}`)
      continue
    }

    try {
      const result = await evaluator({ inputs: JSON.stringify(inputs), outputs: outputMessage, context })
      scores[name] = result.score

      await langsmithClient.createFeedback(runId, name, {
        score: result.score,
        comment: result.comment || '',
        feedbackSourceType: 'model'
      })

      if (verbose) {
        console.log(`  ${name}: ${result.score.toFixed(3)}`)
        if (result.comment) console.log(`    ${result.comment}`)
      }
    } catch (err: any) {
      console.warn(`Error running evaluator ${name}: ${err.message}`)
    }
  }

  return scores
}

// ---------------------------------------------------------------------------
// Run a single example
// ---------------------------------------------------------------------------

async function runExample(example: Example, testConfig: { llmPlatform: string; llmModel: string }, experimentName: string) {
  const runId = randomUUID()
  const startTime = new Date(Date.now() - 15 * 60 * 1000)
  const templateName = (example.metadata?.templateName as string) ?? 'classroomLecture'
  const template = TEMPLATES[templateName] ?? TEMPLATES.classroomLecture

  if (verbose) {
    console.log(`\n📝 ${example.id} [${templateName} / ${example.metadata?.dimension ?? '?'}]`)
    console.log(`   question: ${example.inputs.userQuestion}`)
  }

  try {
    const setup = await setupAgent(testConfig, template, example.inputs, startTime)
    const conversationHistory = await buildConversationState(setup, example.inputs, startTime)

    const dmMessage = await createDirectMessage(example.inputs.userQuestion, setup.user, setup.conversation)

    await langsmithClient.createRun({
      id: runId,
      name: example.id,
      run_type: 'chain',
      project_name: experimentName,
      inputs: example.inputs,
      reference_example_id: example.id,
      extra: { metadata: { templateName, dimension: example.metadata?.dimension } }
    })

    setup.agent.conversationHistorySettings = {
      endTime: new Date(startTime.getTime() + (example.inputs.endTimeSeconds ?? 300) * 1000),
      count: 100,
      directMessages: true
    }

    const responses = await defaultAgentTypes.eventAssistant.respond.call(setup.agent, conversationHistory, dmMessage)

    // Find the DM response back to the participant
    const targetChannelName = `direct-agents-${setup.user._id}`
    const targetResponse = (responses as any[])?.find((r) => r.channels?.[0]?.name === targetChannelName)
    const outputMessage: string = targetResponse?.message?.text ?? targetResponse?.message ?? 'NO_RESPONSE'

    if (verbose) console.log(`   → ${outputMessage}`)

    await langsmithClient.updateRun(runId, {
      outputs: { message: outputMessage },
      end_time: new Date().toISOString()
    })

    const judgeContext = makeJudgeContext(example.inputs, templateName, template.behaviorPolicy)
    const scores = await runEvaluators(example.inputs, outputMessage, judgeContext, runId)

    return { testCaseId: example.id, runId, success: true, output: outputMessage, scores }
  } catch (err: any) {
    console.error(`❌ ${example.id}: ${err.message}`)
    try {
      await langsmithClient.updateRun(runId, { error: err.message, end_time: new Date().toISOString() })
    } catch {
      /* ignore */
    }
    return { testCaseId: example.id, runId, success: false, error: err.message }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🔬 Behavior Policy Evaluation Suite')
  console.log('='.repeat(60))

  const experimentName = makeExperimentName()
  console.log(`🧪 Experiment: ${experimentName}`)

  const testConfig = {
    llmPlatform: process.env.TEST_LLM_PLATFORM || defaultAgentTypes.eventAssistant.defaultLLMPlatform,
    llmModel: process.env.TEST_LLM_MODEL || defaultAgentTypes.eventAssistant.defaultLLMModel
  }

  await initializeAgentEvaluators()

  await mongoose.connect(config.mongoose.url, {
    ...config.mongoose.options,
    autoIndex: false
  })

  const dataset = await langsmithClient.readDataset({ datasetName })
  const examples = langsmithClient.listExamples({ datasetId: dataset.id })

  const experiment = await langsmithClient.createProject({
    projectName: experimentName,
    referenceDatasetId: dataset.id,
    metadata: { llmPlatform: testConfig.llmPlatform, llmModel: testConfig.llmModel, gitSha: getGitSha() }
  })

  console.log(`🆔 Experiment ID: ${experiment.id}`)

  let examplesArray: Example[] = []
  for await (const ex of examples) examplesArray.push(ex)

  if (exampleFilter) {
    examplesArray = examplesArray.filter((ex) => ex.metadata?.name === exampleFilter)
    if (examplesArray.length === 0) {
      console.error(`No example found with name: "${exampleFilter}"`)
      process.exit(1)
    }
  }

  if (dimensionFilter) {
    examplesArray = examplesArray.filter((ex) => ex.metadata?.dimension === dimensionFilter)
    if (examplesArray.length === 0) {
      console.error(`No examples found for dimension: "${dimensionFilter}"`)
      process.exit(1)
    }
  }

  console.log(`\n📋 Running ${examplesArray.length} example${examplesArray.length === 1 ? '' : 's'}`)

  const allResults: any[] = []
  for (const example of examplesArray) {
    const result = await runExample(example, testConfig, experimentName)
    allResults.push(result)
    if (!verbose) console.log(result.success ? `✓ ${result.testCaseId}` : `✗ ${result.testCaseId}`)
  }

  console.log('\n✅ All runs complete')
  const successful = allResults.filter((r) => r.success).length
  console.log(`✅ Successful: ${successful}/${allResults.length}`)
  console.log(`❌ Failed: ${allResults.length - successful}/${allResults.length}`)

  const workspaceId = dataset.tenant_id || experiment.tenant_id
  console.log(`\n🔗 View Experiment: https://smith.langchain.com/o/${workspaceId}/datasets/${dataset.id}?tab=0`)
  if (allResults.some((r) => !r.success)) process.exit(1)
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
