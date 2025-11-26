import mongoose from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'
import { Message } from '../../../../src/models/index.js'
import { defaultLLMTemplates } from '../../../../src/agents/development/delegates/prompts.js'
import vote from '../../../../src/agents/development/delegates/voteOnConversationPhases.js'
import { formatConversationPhases } from '../../../../src/agents/helpers/llmInputFormatters.js'
import { getModelChat } from '../../../../src/agents/helpers/getModelChat.js'
import { IMessage } from '../../../../src/types/index.types.js'

jest.setTimeout(120000)

let llm

const delegates = [
  {
    personality: 'You are a wealthy woman from San Francisco who thinks AI will be great for humanity.',
    interest: "Why do so many people think AI will be dangerous? I don't understand their concerns.",
    pseudonym: 'Pro AI Urban Woman'
  },
  {
    personality:
      'You are a working class man from Omaha, Nebraska who recently watch the movie "The Terminator" and are concerned about AI controlled robots taking over our world.',
    interest: 'Why are not more people concerned about AI controlled robots?',
    pseudonym: 'Anti AI Rural Man'
  },
  {
    personality:
      "You are a college student curious about tech who has had recent good experiences using OpenAI to help with your paper writing. But you also don't trust the big tech companies.",
    interest:
      "I like what I see AI can do for me. Why can't government properly regulate AI companies to make sure nothing bad happens?",
    pseudonym: 'AI Curious College Student'
  }
]

const topic = 'Exploring the book "The Line: AI and the Future of Personhood" by James Boyle'
const owner = new mongoose.Types.ObjectId()
const conversation = new mongoose.Types.ObjectId()
const ownerPseudo = new mongoose.Types.ObjectId()
setupIntTest()
describe('delegate agent voting tests', () => {
  async function createMessage(body, pseudonym) {
    const msg = new Message({
      _id: new mongoose.Types.ObjectId(),
      body,
      conversation,
      owner,
      pseudonymId: ownerPseudo,
      pseudonym,
      fromAgent: true
    })
    await msg.save()
    return msg
  }

  beforeAll(async () => {
    llm = await getModelChat('openai', 'gpt-4o-mini', { temperature: 1.2 })
  })
  it('should not choose the discussion that begins with its own question', async () => {
    const phasedHistory: { question: IMessage; conversation: Array<IMessage> }[] = []
    const messages: IMessage[] = []
    const question1 = await createMessage('Should AI be granted any form of legal personhood?', 'AI Curious College Student')
    messages.push(
      await createMessage('I think AI should have rights if it demonstrates consciousness.', 'Pro AI Urban Woman')
    )
    messages.push(
      await createMessage('But how do we define consciousness? Isn’t it just simulation?', 'AI Curious College Student')
    )
    phasedHistory.push({ question: question1, conversation: messages })

    const messages2: IMessage[] = []
    const question2 = await createMessage('How do we ensure AI does not destroy humanity?', 'Anti AI Rural Man')
    messages2.push(
      await createMessage(
        'I think concerns about that are overblown. There are always humans monitoring AI',
        'Pro AI Urban Woman'
      )
    )
    messages2.push(
      await createMessage(
        'It is a little concerning. AI technology is so powerful and there is a lot we do not know',
        'AI Curious College Student'
      )
    )
    phasedHistory.push({ question: question2, conversation: messages2 })

    const chunks = formatConversationPhases(phasedHistory)
    const winners = await vote(llm, topic, delegates[1], defaultLLMTemplates.voting, chunks)
    expect(winners).toHaveLength(1)
    // It had to choose the first question b/c it posed the second
    expect(winners[0].chunk).toBe(1)
    expect(winners[0].reason).not.toBeUndefined()
  })
})
