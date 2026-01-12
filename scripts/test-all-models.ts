#!/usr/bin/env node
/* eslint-disable no-console */
import { spawn } from 'child_process'
import { supportedModels } from '../src/agents/helpers/getModelChat.js'

interface TestResult {
  modelName: string
  platform: string
  model: string
  success: boolean
  error?: string
  duration?: number
}

const results: TestResult[] = []

console.log(`\n${'='.repeat(80)}`)
console.log('Running agent tests against all supported models')
console.log(`${'='.repeat(80)}\n`)
console.log(`Found ${supportedModels.length} supported models:\n`)
supportedModels.forEach((model) => {
  console.log(`  - ${model.label} (${model.llmPlatform}/${model.llmModel})`)
})
console.log('\n')

async function runTestForModel(modelConfig: (typeof supportedModels)[0]): Promise<TestResult> {
  const { label, llmPlatform, llmModel } = modelConfig

  console.log('='.repeat(80))
  console.log(`Testing: ${label}`)
  console.log(`Platform: ${llmPlatform} | Model: ${llmModel}`)
  console.log('='.repeat(80))

  const startTime = Date.now()

  return new Promise((resolve) => {
    const env = {
      ...process.env,
      TEST_LLM_PLATFORM: llmPlatform,
      TEST_LLM_MODEL: llmModel
    }

    const child = spawn('yarn', ['test:agents'], {
      stdio: 'inherit',
      env,
      shell: true
    })

    child.on('close', (code) => {
      const duration = Date.now() - startTime

      if (code === 0) {
        console.log(`\n✓ ${label} tests passed (${(duration / 1000).toFixed(2)}s)\n`)
        resolve({
          modelName: label,
          platform: llmPlatform,
          model: llmModel,
          success: true,
          duration
        })
      } else {
        console.error(`\n✗ ${label} tests failed with exit code ${code} (${(duration / 1000).toFixed(2)}s)\n`)
        resolve({
          modelName: label,
          platform: llmPlatform,
          model: llmModel,
          success: false,
          error: `Exit code: ${code}`,
          duration
        })
      }
    })

    child.on('error', (error) => {
      const duration = Date.now() - startTime
      console.error(`\n✗ ${label} tests failed with error: ${error.message} (${(duration / 1000).toFixed(2)}s)\n`)
      resolve({
        modelName: label,
        platform: llmPlatform,
        model: llmModel,
        success: false,
        error: error.message,
        duration
      })
    })
  })
}

async function main() {
  // Run tests sequentially
  for (const modelConfig of supportedModels) {
    const result = await runTestForModel(modelConfig)
    results.push(result)
  }

  // Print summary
  console.log(`\n${'='.repeat(80)}`)
  console.log('TEST SUMMARY')
  console.log(`${'='.repeat(80)}\n`)

  const passed = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  console.log(`Total models tested: ${results.length}`)
  console.log(`Passed: ${passed.length}`)
  console.log(`Failed: ${failed.length}`)
  console.log()

  if (passed.length > 0) {
    console.log('✓ Passed:')
    passed.forEach((result) => {
      const duration = result.duration ? ` (${(result.duration / 1000).toFixed(2)}s)` : ''
      console.log(`  - ${result.modelName}${duration}`)
    })
    console.log()
  }

  if (failed.length > 0) {
    console.log('✗ Failed:')
    failed.forEach((result) => {
      const duration = result.duration ? ` (${(result.duration / 1000).toFixed(2)}s)` : ''
      console.log(`  - ${result.modelName}${duration}`)
    })
    console.log()
  }

  const totalDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0)
  console.log(`Total time: ${(totalDuration / 1000).toFixed(2)}s`)
  console.log(`${'='.repeat(80)}\n`)

  // Exit with error code if any tests failed
  if (failed.length > 0) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
