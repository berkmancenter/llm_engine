/* eslint-disable no-console */
import { generateVisualResponse } from '../../../src/agents/eventAssistant/imageGenerator.js'

jest.setTimeout(180000)

const testTimeout = 120000

describe('imageGenerator integration tests', () => {
  describe('generateVisualResponse', () => {
    it(
      'should successfully generate an image with valid response',
      async () => {
        const result = await generateVisualResponse(
          'Create a simple diagram showing the water cycle with evaporation, condensation, and precipitation',
          'Educational context for a science class'
        )

        if (!result.success) {
          console.log('Image generation failed:', result.error)
        }
        expect(result.success).toBe(true)
        expect(result.error).toBeUndefined()
        expect(result.imageData).toBeDefined()
        expect(result.mimeType).toBeDefined()
        expect(result.mimeType).toMatch(/^image\//) // Should be an image MIME type

        // Verify it's a valid base64 string (without data URI prefix)
        expect(result.imageData!.length).toBeGreaterThan(100) // Should be a substantial image
        // Base64 strings should only contain valid base64 characters
        expect(result.imageData).toMatch(/^[A-Za-z0-9+/]+=*$/)
      },
      testTimeout
    )

    it(
      'should generate different images for different prompts',
      async () => {
        const result1 = await generateVisualResponse('Create a diagram of a simple food chain')
        const result2 = await generateVisualResponse('Create a diagram showing parts of a plant')

        expect(result1.success).toBe(true)
        expect(result2.success).toBe(true)

        // Images should be different
        expect(result1.imageData).not.toEqual(result2.imageData)
      },
      testTimeout
    )

    it(
      'should work without context parameter',
      async () => {
        const result = await generateVisualResponse('Create a diagram showing the solar system')

        expect(result.success).toBe(true)
        expect(result.imageData).toBeDefined()
        expect(result.mimeType).toBeDefined()
        expect(result.mimeType).toMatch(/^image\//)
        expect(result.imageData).toMatch(/^[A-Za-z0-9+/]+=*$/)
      },
      testTimeout
    )

    it(
      'should generate images for process flows',
      async () => {
        const result = await generateVisualResponse(
          'The scientific method: 1) Ask a question, 2) Do background research, 3) Construct a hypothesis, 4) Test with an experiment, 5) Analyze results, 6) Draw conclusions'
        )

        expect(result.success).toBe(true)
        expect(result.imageData).toBeDefined()
        expect(result.mimeType).toBeDefined()
        expect(result.mimeType).toMatch(/^image\//)
        expect(result.imageData).toMatch(/^[A-Za-z0-9+/]+=*$/)
      },
      testTimeout
    )

    it(
      'should handle context truncation for long context',
      async () => {
        const longContext = 'a'.repeat(1000) // 1000 character context
        const result = await generateVisualResponse('Create a simple diagram', longContext)

        // Should still succeed despite long context (it gets truncated to 500 chars)
        expect(result.success).toBe(true)
        expect(result.imageData).toBeDefined()
      },
      testTimeout
    )

    it(
      'should generate educational visuals',
      async () => {
        const result = await generateVisualResponse(
          'Photosynthesis is the process by which plants use sunlight, water, and carbon dioxide to produce oxygen and energy in the form of sugar.',
          'Biology lesson about plant processes'
        )

        expect(result.success).toBe(true)
        expect(result.imageData).toBeDefined()
        expect(result.mimeType).toBeDefined()
        expect(result.mimeType).toMatch(/^image\//)

        // Verify the base64 data is substantial (actual image content)
        expect(result.imageData!.length).toBeGreaterThan(500)
        expect(result.imageData).toMatch(/^[A-Za-z0-9+/]+=*$/)
      },
      testTimeout
    )
  })
})
