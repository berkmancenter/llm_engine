#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Analyze k6 JSON output to find when performance degraded.
 * Usage: node analyzeTimeline.js results.json
 */

import fs from 'fs'
import readline from 'readline'

async function analyzeTimeline(jsonFile, windowSeconds = 60) {
  console.log(`\nAnalyzing ${jsonFile} with ${windowSeconds}s windows...\n`)

  // Data structures for aggregation
  const windows = {}
  let startTime = null

  // Read NDJSON file line by line
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const fileStream = fs.createReadStream(jsonFile)
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  })

  for await (const line of rl) {
    try {
      const data = JSON.parse(line)

      // Skip non-metric entries
      if (data.type !== 'Point') continue

      const metricType = data.metric
      const metricData = data.data
      const timestamp = new Date(metricData.time).getTime()

      if (startTime === null) {
        startTime = timestamp
      }

      // Calculate elapsed seconds and window
      const elapsed = (timestamp - startTime) / 1000
      const window = Math.floor(elapsed / windowSeconds) * windowSeconds

      // Initialize window if needed
      if (!windows[window]) {
        windows[window] = {
          requests: 0,
          failures: 0,
          durations: [],
          timeouts: 0,
          vus: new Set()
        }
      }

      // Track VUs
      if (metricType === 'vus') {
        windows[window].vus.add(metricData.value)
      }

      // Track HTTP requests
      else if (metricType === 'http_reqs') {
        windows[window].requests += metricData.value
      }

      // Track failures
      else if (metricType === 'http_req_failed') {
        if (metricData.value === 1) {
          windows[window].failures += 1
        }
      }

      // Track durations
      else if (metricType === 'http_req_duration') {
        const durationMs = metricData.value
        windows[window].durations.push(durationMs)

        // Track timeouts (>55s)
        if (durationMs > 55000) {
          windows[window].timeouts += 1
        }
      }
    } catch (err) {
      // Skip invalid JSON lines
      continue
    }
  }

  // Calculate statistics per window
  console.log('=== Performance Timeline ===\n')
  console.log(
    'Time(s)'.padEnd(10) +
      'VUs'.padEnd(8) +
      'Reqs'.padEnd(8) +
      'Fails'.padEnd(8) +
      'Fail%'.padEnd(8) +
      'P50(ms)'.padEnd(10) +
      'P95(ms)'.padEnd(10) +
      'Timeouts'.padEnd(10)
  )
  console.log('-'.repeat(88))

  let degradationPoint = null

  const windowKeys = Object.keys(windows)
    .map(Number)
    .sort((a, b) => a - b)

  for (const window of windowKeys) {
    const w = windows[window]

    if (w.durations.length === 0) continue

    // Calculate stats
    const vus = w.vus.size > 0 ? Math.max(...w.vus) : 0
    const { requests, failures } = w
    const failRate = requests > 0 ? (failures / requests) * 100 : 0

    const durations = w.durations.sort((a, b) => a - b)
    const p50 = durations[Math.floor(durations.length / 2)] || 0
    const p95Idx = Math.floor(durations.length * 0.95)
    const p95 = durations[p95Idx] || 0

    // Identify degradation (fail rate > 10% or P95 > 10s)
    let status = ''
    if ((failRate > 10 || p95 > 10000) && degradationPoint === null) {
      degradationPoint = window
      status = ' ⚠️  DEGRADATION STARTS'
    }

    console.log(
      `${
        String(window).padEnd(10) +
        String(vus).padEnd(8) +
        String(requests).padEnd(8) +
        String(failures).padEnd(8) +
        failRate.toFixed(1).padEnd(7)
      }% ${p50.toFixed(0).padEnd(10)}${p95.toFixed(0).padEnd(10)}${String(w.timeouts).padEnd(10)}${status}`
    )
  }

  // Summary
  console.log('\n=== Analysis Summary ===\n')
  if (degradationPoint !== null) {
    console.log(`🔍 Performance degradation detected at T+${degradationPoint}s`)

    // Look up VU count at that time
    if (windows[degradationPoint]) {
      const vusAtDegradation =
        windows[degradationPoint].vus.size > 0 ? Math.max(...windows[degradationPoint].vus) : 'unknown'
      console.log(`   VUs at degradation: ~${vusAtDegradation}`)

      if (typeof vusAtDegradation === 'number') {
        console.log(
          `\n💡 Your system can handle approximately ${Math.floor(
            vusAtDegradation * 0.8
          )}-${vusAtDegradation} concurrent users`
        )
      }
    }
  } else {
    console.log('✅ No significant degradation detected in test duration')
  }

  console.log()
}

const args = process.argv.slice(2)

if (args.length === 0) {
  console.log('Usage: node analyze_k6_timeline.js results.json [windowSeconds]')
  console.log('Example: node analyze_k6_timeline.js results.json 60')
  process.exit(1)
}

const jsonFile = args[0]
const windowSeconds = args[1] ? parseInt(args[1], 10) : 60

// eslint-disable-next-line security/detect-non-literal-fs-filename
if (!fs.existsSync(jsonFile)) {
  console.error(`Error: File '${jsonFile}' not found`)
  process.exit(1)
}

analyzeTimeline(jsonFile, windowSeconds).catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
