/* eslint-disable no-console */
import { Client } from 'langsmith'
import { stringify } from 'csv-stringify/sync'
import fs from 'fs'
import config from '../../src/config/config.js'

/**
 * Loads a LangSmith dataset and exports it to a CSV file.
 *
 * Langsmith datasets can be manually created in the dashboard from a set of Traces representing a single event.
 * This script fetches all examples from the specified dataset and writes the relevant input, output, and context to a CSV file
 * for analysis, evaluation, and testing.
 *
 * USAGE:
 * NODE_ENV=... node --loader ts-node/esm tests/utils/loadLangsmithDataset.ts [dataset name] <optional output file name>
 * Specifying the NODE_ENV
 *
 * If no output file is specified, it defaults to 'examples.csv'.
 */
const client = new Client({ apiKey: config.langsmith.key })

function cleanText(str) {
  if (!str) return ''

  return (
    str
      .normalize('NFKC') // normalize unicode (composition form)
      // Curly single quotes/apostrophes → straight '
      .replace(/[\u2018\u2019\u02BC]/g, "'")
      // Curly double quotes → straight "
      .replace(/[\u201C\u201D]/g, '"')
      // En dash, em dash → hyphen
      .replace(/[\u2013\u2014]/g, '-')
      // Ellipsis → "..."
      .replace(/\u2026/g, '...')
      // Non-breaking space and weird spaces → regular space
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ') // collapse multiple spaces/newlines
      .trim()
  )
}

async function exportDatasetToCsv(datasetName, outputFile) {
  // Get dataset by name
  const dataset = await client.readDataset({ datasetName })
  if (!dataset) {
    console.error(`Dataset "${datasetName}" not found.`)
    return
  }

  // Fetch all examples
  const examples = await client.listExamples({ datasetId: dataset.id })

  // Prepare data rows
  const rows: string[][] = []

  for await (const example of examples) {
    let time = example?.inputs?.args?.[0]?.end ?? ''
    if (time) {
      // Extract just HH:MM:SS from ISO string
      const match = time.match(/\d{2}:\d{2}:\d{2}/)
      time = match ? match[0] : time
    }
    const user = example?.inputs?.args[1]?.pseudonym ?? ''
    const input = cleanText(example?.inputs?.args[1]?.body ?? '')
    const output = cleanText(example?.outputs?.outputs[0]?.message ?? '')
    const context = cleanText(example?.outputs?.outputs[0]?.context ?? '')

    rows.push([time, user, input, output, context])
  }

  // Convert to CSV string with escaping enabled
  const csvContent = stringify(rows, {
    header: true,
    columns: ['Time', 'User', 'Input', 'Output', 'Context'],
    quoted: true, // wrap all fields in quotes
    quoted_empty: true // also quote empty strings
  })

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  fs.writeFileSync(outputFile, csvContent, 'utf8')

  console.log(`✅ Wrote ${rows.length} examples to ${outputFile}`)
}
const args = process.argv.slice(2)
const outputFile = args[1] || 'examples.csv'
exportDatasetToCsv(args[0], outputFile).catch(console.error)
