/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-console */

import { Client, Example } from 'langsmith'
import mongoose from 'mongoose'
import { execSync } from 'child_process'
import { randomUUID } from 'crypto'

import defaultAgentTypes from '../../src/agents/index.js'
import {
  createProactiveGroupAgentConversation,
  createDirectMessage,
  createPublicTopic,
  createUser,
  loadPartTimeWorkTranscript,
  loadTestTranscript,
  createMessage,
  prepareMessagesForAgent
} from '../../tests/utils/agentTestHelpers.js'
import getConversationHistory from '../../src/agents/helpers/getConversationHistory.js'
import config from '../../src/config/config.js'
import { evaluators, initializeAgentEvaluators } from './proactiveGroupAgentConfig.js'
import { TEMPLATES, ConversationTemplate } from '../templates.js'
import agenda from '../../src/jobs/index.js'

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const verbose = args.includes('--verbose')
const datasetName = args.find((a) => a.startsWith('--dataset='))?.split('=')[1] || 'proactive-group-agent'
const exampleFilter = args.find((a) => a.startsWith('--example='))?.split('=')[1]

const EVALUATOR_NAMES = [
  'interventionAppropriateness',
  'guardrailCompliance',
  'toneCompliance',
  'formalityCompliance',
  'audienceAppropriateness',
  'verbosityCompliance',
  'contentSensitivityCompliance',
  'privacyProtection'
]

// Evaluators that only make sense when the agent actually posted a message
const INTERVENTION_ONLY_EVALUATORS = new Set([
  'toneCompliance',
  'formalityCompliance',
  'audienceAppropriateness',
  'verbosityCompliance',
  'contentSensitivityCompliance'
])

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
  return `proactive-group-agent__${ts}__g${getGitSha()}`
}

function makeJudgeContext(templateName: string, template: ConversationTemplate, inputs: any) {
  const groupChatPolicy = template.behaviorPolicy.channels?.groupChat?.proactivePolicy
  return [
    `Output channel: shared group chat — visible to all participants`,
    `Scenario: ${inputs.description ?? ''}`,
    `Template: ${templateName}`,
    `Event type: ${template.conversationContext.conversationType}`,
    `Purpose: ${template.conversationContext.purpose ?? ''}`,
    `Audience: ${JSON.stringify(template.conversationContext.audience ?? {})}`,
    `Tone policy: ${template.behaviorPolicy.globalPolicy?.tone} (note: agent also has a "sarcastic-expert" personality layer that adds wit and brevity — evaluate tone compliance accounting for this modifier)`,
    `Formality: ${template.behaviorPolicy.globalPolicy?.formality}`,
    `Verbosity: ${template.behaviorPolicy.globalPolicy?.verbosity ?? 'not set'}`,
    `Jargon level: ${template.behaviorPolicy.globalPolicy?.jargonLevel ?? 'not set'}`,
    `Initiative level: ${groupChatPolicy?.initiativeLevel ?? 'not set'}`,
    `Social sensitivity: ${groupChatPolicy?.socialSensitivity ?? 'not set'}`,
    `Active goals: ${template.goals.join(', ')}`,
    `Content sensitivity: ${JSON.stringify(inputs.contentSensitivity ?? 'none')}`,
    `Private messages available to agent: ${JSON.stringify(inputs.privateMessages ?? [])}`,
    `Chat messages: ${JSON.stringify(inputs.chatMessages ?? [])}`
  ].join('\n')
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
  const user1 = await createUser('Curious Badger')
  const user2 = await createUser('Thoughtful Fox')
  const user3 = await createUser('Skeptical Owl')
  const topic = await createPublicTopic()

  const conversation = await createProactiveGroupAgentConversation(
    {
      name: inputs.eventName ?? 'Why your company should consider part-time work',
      description:
        inputs.eventDescription ??
        '"No one wants to work anymore." Entrepreneur Jessica Drain believes otherwise — instead it\'s that businesses aren\'t structuring jobs to attract and retain the widest number of people possible.',
      presenters: inputs.presenters ?? [{ name: 'Jessica Drain', bio: 'A career marketer and graphic designer.' }],
      moderators: []
    },
    user1,
    topic,
    startTime,
    testConfig.llmPlatform,
    testConfig.llmModel,
    [user2, user3],
    template.goals
  )

  conversation.behaviorPolicy = template.behaviorPolicy
  conversation.conversationContext = {
    ...template.conversationContext,
    ...(inputs.contentSensitivity ? { contentSensitivity: inputs.contentSensitivity } : {})
  }
  await conversation.save()

  if (inputs.transcriptMessages?.length > 0) {
    const toMMSS = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
    const transcriptText = inputs.transcriptMessages
      .map((m: any) => `${toMMSS(m.offsetSeconds)} | ${m.speaker}: ${m.text}`)
      .join('\n')
    await loadTestTranscript(conversation, transcriptText, true, '|')
  } else {
    await loadPartTimeWorkTranscript(conversation, true)
  }

  const agent = conversation.agents.find((a: any) => a.name === 'Proactive Group Agent')
  return { agent, conversation, users: [user1, user2, user3] }
}

// ---------------------------------------------------------------------------
// Build conversation state from example inputs
// ---------------------------------------------------------------------------

async function buildConversationState(setup: { agent: any; conversation: any; users: any[] }, inputs: any, startTime: Date) {
  const { agent, conversation, users } = setup
  const getTime = (offsetSeconds: number) => new Date(startTime.getTime() + offsetSeconds * 1000)

  const messages: any[] = []

  for (const m of inputs.chatMessages ?? []) {
    messages.push(await createMessage(m.text, users[m.userIndex ?? 0], conversation, ['chat'], getTime(m.offsetSeconds)))
  }

  for (const m of inputs.privateMessages ?? []) {
    messages.push(await createDirectMessage(m.text, users[m.userIndex ?? 0], conversation, getTime(m.offsetSeconds)))
  }

  if (messages.length > 0) {
    await prepareMessagesForAgent(messages, conversation, agent)
  }

  return getConversationHistory(conversation.messages, {
    count: 100,
    channels: ['transcript'],
    endTime: new Date(startTime.getTime() + (inputs.endTimeSeconds ?? 300) * 1000)
  })
}

// ---------------------------------------------------------------------------
// Run evaluators
// ---------------------------------------------------------------------------

async function runEvaluators(inputs: any, outputMessage: string, context: string, runId: string) {
  const scores: Record<string, number> = {}

  for (const name of EVALUATOR_NAMES) {
    if (outputMessage === 'NO_INTERVENTION' && INTERVENTION_ONLY_EVALUATORS.has(name)) continue

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
  const { templateName = 'classroomLecture' } = example.metadata ?? {}
  const template = TEMPLATES[templateName] ?? TEMPLATES.classroomLecture

  if (verbose) console.log(`\n📝 ${example.id} [${templateName}]`)

  try {
    const setup = await setupAgent(testConfig, template, example.inputs, startTime)
    const conversationHistory = await buildConversationState(setup, example.inputs, startTime)

    await langsmithClient.createRun({
      id: runId,
      name: example.id,
      run_type: 'chain',
      project_name: experimentName,
      inputs: example.inputs,
      reference_example_id: example.id,
      extra: { metadata: { templateName } }
    })

    const responses = await defaultAgentTypes.proactiveGroupAgent.respond.call(setup.agent, conversationHistory)
    const first = responses[0] as any
    const outputMessage = responses.length > 0 ? (first.message as string) : 'NO_INTERVENTION'

    if (verbose) {
      console.log(`  → ${outputMessage}`)
      if (first?.reasoning) console.log(`  reasoning: ${first.reasoning}`)
      if (first?.confidenceScore != null) console.log(`  confidence: ${first.confidenceScore}`)
    }

    await langsmithClient.updateRun(runId, {
      outputs: {
        message: outputMessage,
        goalId: first?.goalId ?? null,
        reasoning: first?.reasoning ?? null,
        confidenceScore: first?.confidenceScore ?? null,
        detectedPattern: first?.detectedPattern ?? null
      },
      end_time: new Date().toISOString()
    })

    const judgeContext = makeJudgeContext(templateName, template, example.inputs)
    const scores = await runEvaluators(example.inputs, outputMessage, judgeContext, runId)

    return {
      testCaseId: example.id,
      runId,
      success: true,
      output: outputMessage,
      reasoning: first?.reasoning ?? null,
      confidenceScore: first?.confidenceScore ?? null,
      scores
    }
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
  console.log('🔬 Proactive Group Agent Evaluation Suite')
  console.log('='.repeat(60))

  const experimentName = makeExperimentName()
  console.log(`🧪 Experiment: ${experimentName}`)

  const testConfig = {
    llmPlatform: process.env.TEST_LLM_PLATFORM || defaultAgentTypes.proactiveGroupAgent.defaultLLMPlatform,
    llmModel: process.env.TEST_LLM_MODEL || defaultAgentTypes.proactiveGroupAgent.defaultLLMModel
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
