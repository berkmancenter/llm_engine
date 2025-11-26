import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TYPES_PATH = path.join(__dirname, '../../src/types/openapi.d.ts')

describe('openapi-types:generate script', () => {
  beforeAll(() => {
    // Remove the types file if it exists
    if (fs.existsSync(TYPES_PATH)) {
      fs.unlinkSync(TYPES_PATH)
    }
  })

  it('should generate openapi.d.ts in the expected location (requires running local server)', () => {
    // Run the script
    execSync('yarn run openapi-types:generate', { stdio: 'inherit' })

    // Check that the file exists
    expect(fs.existsSync(TYPES_PATH)).toBe(true)

    // Check that the file is non-empty
    const content = fs.readFileSync(TYPES_PATH, 'utf8')
    expect(content.length).toBeGreaterThan(0)

    // Optionally, check for expected TypeScript content
    expect(content).toMatch(/export /)
    expect(content).toMatch(/interface |type /)
  })
})
