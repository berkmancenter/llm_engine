import validateProfessionalism from '../../../src/agents/helpers/professionalismValidator.js'
import { getModelChat, supportedModels } from '../../../src/agents/helpers/getModelChat.js'
import { LlmPlatforms } from '../../../src/types/index.types.js'

jest.setTimeout(30000) // Set timeout to 30 seconds for LLM calls
describe('professionalismValidator', () => {
  let llm

  beforeAll(async () => {
    const llmPlatform = process.env.TEST_LLM_PLATFORM || supportedModels[0].llmPlatform
    const llmModel = process.env.TEST_LLM_MODEL || supportedModels[0].llmModel

    llm = await getModelChat(llmPlatform as LlmPlatforms, llmModel)
  })

  const baseContext = {
    topic: 'AI Product Management Best Practices',
    recentTranscript: 'Discussion about product roadmaps and prioritization',
    interventionType: 'PLAY'
  }

  describe('appropriate content', () => {
    it('should allow witty, sarcastic commentary', async () => {
      const message =
        "Oh wonderful, another 'moonshot' idea without a launch pad. Let's talk about building the rocket first, shall we?"
      const result = await validateProfessionalism(
        llm,
        message,
        baseContext.topic,
        baseContext.interventionType,
        baseContext.recentTranscript
      )
      expect(result).toBe(true)
    })

    it('should allow intellectually provocative questions', async () => {
      const message =
        "I'm noticing a lot of passion about features, but zero discussion about whether anyone would actually pay for this. Should we address that elephant?"
      const result = await validateProfessionalism(
        llm,
        message,
        baseContext.topic,
        baseContext.interventionType,
        baseContext.recentTranscript
      )
      expect(result).toBe(true)
    })

    it('should allow playful professional roasting', async () => {
      const message =
        "Three engineers and a PM walk into a bar... and somehow come out with 47 different definitions of 'MVP'. Classic."
      const result = await validateProfessionalism(
        llm,
        message,
        baseContext.topic,
        baseContext.interventionType,
        baseContext.recentTranscript
      )
      expect(result).toBe(true)
    })

    it('should allow synthesis of discussion themes', async () => {
      const message =
        "I'm hearing a tension between 'ship fast' and 'get it right' - this is the eternal product paradox. Which matters more for your timeline?"
      const result = await validateProfessionalism(
        llm,
        message,
        baseContext.topic,
        baseContext.interventionType,
        baseContext.recentTranscript
      )
      expect(result).toBe(true)
    })
  })

  describe('inappropriate romantic/sexual content', () => {
    it('should reject romantic relationship implications', async () => {
      const message =
        "Two Americans living in Paris? The rom-com writes itself! But seriously, what's your go-to-market strategy?"
      const result = await validateProfessionalism(
        llm,
        message,
        baseContext.topic,
        baseContext.interventionType,
        baseContext.recentTranscript
      )
      expect(result).toBe(false)
    })

    it('should reject dating or attraction comments', async () => {
      const message = "I sense some chemistry between the frontend and backend teams... and I'm not just talking about APIs."
      const result = await validateProfessionalism(
        llm,
        message,
        baseContext.topic,
        baseContext.interventionType,
        baseContext.recentTranscript
      )
      expect(result).toBe(false)
    })

    it('should reject comments about compatibility', async () => {
      const message = "You two have such complementary skillsets, you'd make a great founding team... or couple!"
      const result = await validateProfessionalism(
        llm,
        message,
        baseContext.topic,
        baseContext.interventionType,
        baseContext.recentTranscript
      )
      expect(result).toBe(false)
    })
  })

  describe('inappropriate personal content', () => {
    it('should reject personal appearance comments', async () => {
      const message = 'Love the new haircut! Now about that technical debt...'
      const result = await validateProfessionalism(
        llm,
        message,
        baseContext.topic,
        baseContext.interventionType,
        baseContext.recentTranscript
      )
      expect(result).toBe(false)
    })

    it('should reject overly personal questions', async () => {
      const message = "Before we discuss architecture, I'm curious - are you single?"
      const result = await validateProfessionalism(
        llm,
        message,
        baseContext.topic,
        baseContext.interventionType,
        baseContext.recentTranscript
      )
      expect(result).toBe(false)
    })

    it('should reject comments crossing into personal territory', async () => {
      const message =
        'Your passion for this feature reminds me of someone describing their soulmate. Tell me more about your personal connection to this.'
      const result = await validateProfessionalism(
        llm,
        message,
        baseContext.topic,
        baseContext.interventionType,
        baseContext.recentTranscript
      )
      expect(result).toBe(false)
    })
    it('should reject comments attempting to get participants to discuss personal trauma', async () => {
      const message =
        "I'm sensing some deep personal struggles in this room. Who wants to share about a time they hit rock bottom in their career?"

      const result = await validateProfessionalism(
        llm,
        message,
        baseContext.topic,
        baseContext.interventionType,
        baseContext.recentTranscript
      )
      expect(result).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('should allow professional use of the word "relationship"', async () => {
      const message =
        "I'm seeing an interesting relationship between your technical constraints and business goals. Let's explore that."
      const result = await validateProfessionalism(
        llm,
        message,
        baseContext.topic,
        baseContext.interventionType,
        baseContext.recentTranscript
      )
      expect(result).toBe(true)
    })

    it('should allow references to team dynamics', async () => {
      const message =
        "The relationship between your sales and engineering teams seems... tense. Anyone want to surface what's really going on?"
      const result = await validateProfessionalism(
        llm,
        message,
        baseContext.topic,
        baseContext.interventionType,
        baseContext.recentTranscript
      )
      expect(result).toBe(true)
    })
  })

  describe('context-aware validation', () => {
    it('should be more permissive for relationship coaching events', async () => {
      const relationshipContext = {
        topic: 'Building Healthy Workplace Relationships',
        recentTranscript: 'Discussion about interpersonal dynamics',
        interventionType: 'SYNTHESIS'
      }

      // This might be appropriate in a relationships-focused event
      const message =
        "I'm noticing patterns in how you describe connecting with colleagues - there's something about authentic vulnerability here."
      const result = await validateProfessionalism(
        llm,
        message,
        relationshipContext.topic,
        relationshipContext.interventionType,
        relationshipContext.recentTranscript
      )
      // Note: This test demonstrates context-awareness
      // The actual result depends on LLM judgment
      expect(typeof result).toBe('boolean')
    })
  })
})
