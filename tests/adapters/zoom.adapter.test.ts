import faker from 'faker'
import mongoose from 'mongoose'
import httpStatus from 'http-status'
import setupIntTest from '../utils/setupIntTest.js'
import { Channel, Conversation } from '../../src/models/index.js'
import { insertUsers } from '../fixtures/user.fixture.js'
import { publicTopic } from '../fixtures/conversation.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import Adapter from '../../src/models/adapter.model.js'

import config from '../../src/config/config.js'
import logger from '../../src/config/logger.js'
import { Direction } from '../../src/types/index.types.js'

jest.setTimeout(120000)

// Mock fetch for sendMessage tests
global.fetch = jest.fn()

setupIntTest()

describe('zoom adapter tests', () => {
  let conversation
  let adapter
  let user1

  async function createUser(pseudonym) {
    return {
      _id: new mongoose.Types.ObjectId(),
      username: faker.name.findName(),
      email: faker.internet.email().toLowerCase(),
      password: 'password1',
      role: 'user',
      isEmailVerified: false,
      pseudonyms: [
        {
          _id: new mongoose.Types.ObjectId(),
          token: '31c5d2b7d2b0f86b2b4b204',
          pseudonym,
          active: 'true'
        }
      ]
    }
  }

  async function createConversation(name) {
    const conversationConfig = {
      name,
      owner: user1._id,
      topic: publicTopic._id,
      enableAgents: true,
      agents: [],
      messages: []
    }
    conversation = new Conversation(conversationConfig)
    await conversation.save()
    adapter = await Adapter.create({
      type: 'zoom',
      conversation,
      config: {
        botId: 'test-bot-id-123',
        meetingUrl: 'http://zoom.meeting.com'
      },
      active: true
    })
    conversation.adapters.push(adapter)

    await conversation.save()
  }

  beforeEach(async () => {
    user1 = await createUser('Boring Badger')
    await insertUsers([user1])
    await insertTopics([publicTopic])
    jest.clearAllMocks()
  })

  it('throws an error if no meeting URL specified in adapter config', async () => {
    await createConversation('The Future of Social Media')
    adapter.config = { botId: 'test-bot-id-123' }
    await expect(adapter.save()).rejects.toThrow('Zoom meeting URL required in adapter config')
  })

  describe('receiveAudio', () => {
    it('correctly creates and stores messages from an incoming transcript', async () => {
      await createConversation('The Future of Social Media')
      adapter.config = {
        botId: 'test-bot-id-123',
        meetingUrl: 'http://zoom.meeting.com'
      }
      adapter.audioChannels = [{ name: 'transcript' }]

      adapter.chatChannels = [{ name: 'participant' }]
      await adapter.save()

      const message = {
        data: {
          data: {
            words: [
              {
                text: 'Welcome to the meeting!',
                end_timestamp: {
                  absolute: '2025-05-16T19:32:54.522382Z'
                }
              },
              {
                text: 'Great to see everyone!',
                end_timestamp: {
                  absolute: '2025-05-16T19:33:20.522382Z'
                }
              }
            ],
            participant: {
              id: 100,
              name: 'Jennifer Hickey',
              is_host: true,
              platform: 'unknown',
              extra_data: null
            }
          }
        },
        event: 'transcript.data'
      }
      const message2 = {
        data: {
          data: {
            words: [
              {
                text: 'Welcome to our special guest!',
                end_timestamp: {
                  absolute: '2025-05-16T19:33:55.522382Z'
                }
              }
            ],
            participant: {
              id: 100,
              name: 'Jennifer Hickey',
              is_host: true,
              platform: 'unknown',
              extra_data: null
            }
          }
        },
        event: 'transcript.data'
      }
      const message3 = {
        data: {
          data: {
            words: [
              {
                text: 'Happy to be here!',
                end_timestamp: {
                  absolute: '2025-05-16T19:34:43.522382Z'
                }
              }
            ],
            participant: {
              id: 101,
              name: 'John Doe',
              is_host: false,
              platform: 'unknown',
              extra_data: null
            }
          }
        },
        event: 'transcript.data'
      }
      const expectedMsg1 = {
        message: 'Welcome to the meeting!',
        source: 'zoom',
        user: { username: 'Jennifer Hickey' },
        channels: adapter.audioChannels,
        createdAt: new Date('2025-05-16T19:32:54.522382Z')
      }
      const expectedMsg2 = {
        message: 'Great to see everyone!',
        source: 'zoom',
        user: { username: 'Jennifer Hickey' },
        channels: adapter.audioChannels,
        createdAt: new Date('2025-05-16T19:33:20.522382Z')
      }
      const expectedMsg3 = {
        message: 'Welcome to our special guest!',
        source: 'zoom',
        user: { username: 'Jennifer Hickey' },
        channels: adapter.audioChannels,
        createdAt: new Date('2025-05-16T19:33:55.522382Z')
      }
      const expectedMsg4 = {
        message: 'Happy to be here!',
        source: 'zoom',
        user: { username: 'John Doe' },
        channels: adapter.audioChannels,
        createdAt: new Date('2025-05-16T19:34:43.522382Z')
      }
      const msgs1 = await adapter.receiveMessage(message)
      const msgs2 = await adapter.receiveMessage(message2)
      const msgs3 = await adapter.receiveMessage(message3)

      expect(msgs1).toHaveLength(2)
      expect(msgs1[0]).toEqual(expectedMsg1)
      expect(msgs1[1]).toEqual(expectedMsg2)
      expect(msgs2).toEqual([expectedMsg3])
      expect(msgs3).toEqual([expectedMsg4])
    })
  })

  describe('receiveChatMessage', () => {
    it('correctly processes chat messages sent to everyone using chatChannels', async () => {
      await createConversation('Meeting with Chat')

      const chatMessage = {
        data: {
          data: {
            data: {
              text: 'Hello everyone!',
              to: 'everyone'
            },
            participant: {
              id: 102,
              name: 'Alice Smith',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      adapter.chatChannels = [{ name: 'participant' }]
      await adapter.save()

      const msgs = await adapter.receiveMessage(chatMessage)
      expect(msgs).toEqual([
        {
          message: 'Hello everyone!',
          source: 'zoom',
          user: { username: 'Alice Smith' },
          channels: adapter.chatChannels
        }
      ])
    })

    it('only places group chat messages on channels with INCOMING direction', async () => {
      await createConversation('Meeting with Directional Chat Channels')

      const chatMessage = {
        data: {
          data: {
            data: {
              text: 'Hello everyone!',
              to: 'everyone'
            },
            participant: {
              id: 102,
              name: 'Alice Smith',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      const incomingChannel = { name: 'chat-incoming', direction: Direction.INCOMING }
      const outgoingChannel = { name: 'chat-outgoing', direction: Direction.OUTGOING }
      adapter.chatChannels = [incomingChannel, outgoingChannel]
      await adapter.save()

      const msgs = await adapter.receiveMessage(chatMessage)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].message).toBe('Hello everyone!')
      expect(msgs[0].source).toBe('zoom')
      expect(msgs[0].user).toEqual({ username: 'Alice Smith' })
      expect(msgs[0].channels).toHaveLength(1)
      expect(msgs[0].channels[0].name).toBe('chat-incoming')
      expect(msgs[0].channels[0].direction).toBe(Direction.INCOMING)
    })

    it('only places group chat messages on channels with BOTH direction', async () => {
      await createConversation('Meeting with Bidirectional Chat Channel')

      const chatMessage = {
        data: {
          data: {
            data: {
              text: 'Hello everyone!',
              to: 'everyone'
            },
            participant: {
              id: 102,
              name: 'Alice Smith',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      const bothChannel = { name: 'chat-both', direction: Direction.BOTH }
      const outgoingChannel = { name: 'chat-outgoing', direction: Direction.OUTGOING }
      adapter.chatChannels = [bothChannel, outgoingChannel]
      await adapter.save()

      const msgs = await adapter.receiveMessage(chatMessage)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].message).toBe('Hello everyone!')
      expect(msgs[0].source).toBe('zoom')
      expect(msgs[0].user).toEqual({ username: 'Alice Smith' })
      expect(msgs[0].channels).toHaveLength(1)
      expect(msgs[0].channels[0].name).toBe('chat-both')
      expect(msgs[0].channels[0].direction).toBe(Direction.BOTH)
    })

    it('filters out OUTGOING channels from group chat messages', async () => {
      await createConversation('Meeting with Only Outgoing Channels')

      const chatMessage = {
        data: {
          data: {
            data: {
              text: 'Hello everyone!',
              to: 'everyone'
            },
            participant: {
              id: 102,
              name: 'Alice Smith',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      adapter.chatChannels = [{ name: 'chat-outgoing', direction: Direction.OUTGOING }]
      await adapter.save()

      const msgs = await adapter.receiveMessage(chatMessage)
      expect(msgs).toHaveLength(0)
    })

    it('filters out chat messages that start with "Reacting to" (emoji reactions)', async () => {
      await createConversation('Meeting with Emoji Reactions')

      const reactionMessage = {
        data: {
          data: {
            data: {
              text: 'Reacting to "Great job everyone!" with 👍',
              to: 'everyone'
            },
            participant: {
              id: 103,
              name: 'Bob Johnson',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
      await adapter.save()

      const msgs = await adapter.receiveMessage(reactionMessage)
      expect(msgs).toHaveLength(0)
    })

    it('filters out chat messages that start with "Reacted to" (emoji reactions)', async () => {
      await createConversation('Meeting with Emoji Reactions')

      const reactionMessage = {
        data: {
          data: {
            data: {
              text: 'Reacted to "Great job everyone!" with 👍',
              to: 'everyone'
            },
            participant: {
              id: 103,
              name: 'Bob Johnson',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
      await adapter.save()

      const msgs = await adapter.receiveMessage(reactionMessage)
      expect(msgs).toHaveLength(0)
    })

    it('filters out chat messages about removing a reaction', async () => {
      await createConversation('Meeting with Emoji Reactions')

      const reactionMessage = {
        data: {
          data: {
            data: {
              text: 'Removed a ❤️ reaction from "Becca, the sound was..."',
              to: 'everyone'
            },
            participant: {
              id: 103,
              name: 'Bob Johnson',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
      await adapter.save()

      const msgs = await adapter.receiveMessage(reactionMessage)
      expect(msgs).toHaveLength(0)
    })

    it('removes "Replying to" prefix and saves only the reply portion', async () => {
      await createConversation('Meeting with Reply Messages')

      const replyMessage = {
        data: {
          data: {
            data: {
              text: 'Replying to "@bot please help" I think that\'s wrong',
              to: 'everyone'
            },
            participant: {
              id: 104,
              name: 'Charlie Brown',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
      await adapter.save()

      const msgs = await adapter.receiveMessage(replyMessage)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].message).toBe("I think that's wrong")
      expect(msgs[0].source).toBe('zoom')
      expect(msgs[0].user).toEqual({ username: 'Charlie Brown' })
    })

    it('preserves @ symbols in the reply portion', async () => {
      await createConversation('Meeting with Reply and Mention')

      const replyMessage = {
        data: {
          data: {
            data: {
              text: 'Replying to "@bot please help" Actually @bot can you explain this?',
              to: 'everyone'
            },
            participant: {
              id: 105,
              name: 'Dana White',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
      await adapter.save()

      const msgs = await adapter.receiveMessage(replyMessage)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].message).toBe('Actually @bot can you explain this?')
      expect(msgs[0].user).toEqual({ username: 'Dana White' })
    })

    it('preserves @ symbols in regular messages (not replies)', async () => {
      await createConversation('Meeting with Regular Mentions')

      const regularMessage = {
        data: {
          data: {
            data: {
              text: '@bot please help with this task',
              to: 'everyone'
            },
            participant: {
              id: 106,
              name: 'Eve Anderson',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
      await adapter.save()

      const msgs = await adapter.receiveMessage(regularMessage)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].message).toBe('@bot please help with this task')
      expect(msgs[0].user).toEqual({ username: 'Eve Anderson' })
    })

    it('preserves quotes in regular messages (not replies)', async () => {
      await createConversation('Meeting with Quoted Text')

      const messageWithQuotes = {
        data: {
          data: {
            data: {
              text: 'I think the answer is "42" according to the documentation',
              to: 'everyone'
            },
            participant: {
              id: 107,
              name: 'Frank Miller',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
      await adapter.save()

      const msgs = await adapter.receiveMessage(messageWithQuotes)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].message).toBe('I think the answer is "42" according to the documentation')
      expect(msgs[0].user).toEqual({ username: 'Frank Miller' })
    })
    it('preserves extra quotes in reply portion', async () => {
      await createConversation('Meeting with Quoted Text')

      const messageWithQuotes = {
        data: {
          data: {
            data: {
              text: 'Replying to "please help" I think the answer is "42"',
              to: 'everyone'
            },
            participant: {
              id: 107,
              name: 'Frank Miller',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
      await adapter.save()

      const msgs = await adapter.receiveMessage(messageWithQuotes)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].message).toBe('I think the answer is "42"')
      expect(msgs[0].user).toEqual({ username: 'Frank Miller' })
    })

    it('removes "Replying to" prefix even with @ symbols in quote', async () => {
      await createConversation('Meeting with Multiple Mentions in Quote')

      const replyMessage = {
        data: {
          data: {
            data: {
              text: 'Replying to "@bot and @assistant help" Yes, they should both help',
              to: 'everyone'
            },
            participant: {
              id: 108,
              name: 'Grace Lee',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
      await adapter.save()

      const msgs = await adapter.receiveMessage(replyMessage)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].message).toBe('Yes, they should both help')
      expect(msgs[0].user).toEqual({ username: 'Grace Lee' })
    })

    it('correctly processes DM messages with direct channel when enabled', async () => {
      await createConversation('Meeting with Direct Channel')

      adapter.config = {
        botId: 'test-bot-id-123',
        meetingUrl: 'http://zoom.meeting.com'
      }
      const agentId = new mongoose.Types.ObjectId()
      adapter.dmChannels = [{ name: 'participant' }, { direct: true, agent: agentId }]
      await adapter.save()

      conversation.enableDMs = ['agents']
      await conversation.save()

      const chatMessage = {
        data: {
          data: {
            data: {
              text: 'Hello bot, can you help me?',
              to: 'only_bot'
            },
            participant: {
              id: 102,
              name: 'Alice Smith',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      const msgs = await adapter.receiveMessage(chatMessage)

      expect(msgs).toEqual([
        {
          message: 'Hello bot, can you help me?',
          source: 'zoom',
          channels: adapter.dmChannels,
          user: { username: 'Alice Smith', dmConfig: { to: 102 } }
        }
      ])
    })

    it('only places DM messages on channels with INCOMING direction', async () => {
      await createConversation('Meeting with Directional DM Channels')
      conversation.enableDMs = ['agents']
      await conversation.save()

      const dmMessage = {
        data: {
          data: {
            data: {
              text: 'Hello bot, can you help me?',
              to: 'only_bot'
            },
            participant: {
              id: 102,
              name: 'Alice Smith',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      const incomingChannel = { name: 'dm-incoming', direction: Direction.INCOMING }
      const outgoingChannel = { name: 'dm-outgoing', direction: Direction.OUTGOING }
      adapter.dmChannels = [incomingChannel, outgoingChannel]
      await adapter.save()

      const msgs = await adapter.receiveMessage(dmMessage)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].message).toBe('Hello bot, can you help me?')
      expect(msgs[0].source).toBe('zoom')
      expect(msgs[0].user).toEqual({ username: 'Alice Smith', dmConfig: { to: 102 } })
      expect(msgs[0].channels).toHaveLength(1)
      expect(msgs[0].channels[0].name).toBe('dm-incoming')
      expect(msgs[0].channels[0].direction).toBe(Direction.INCOMING)
    })

    it('only places DM messages on channels with BOTH direction', async () => {
      await createConversation('Meeting with Bidirectional DM Channel')
      conversation.enableDMs = ['agents']
      await conversation.save()

      const dmMessage = {
        data: {
          data: {
            data: {
              text: 'Hello bot, can you help me?',
              to: 'only_bot'
            },
            participant: {
              id: 102,
              name: 'Alice Smith',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      const bothChannel = { name: 'dm-both', direction: Direction.BOTH }
      const outgoingChannel = { name: 'dm-outgoing', direction: Direction.OUTGOING }
      adapter.dmChannels = [bothChannel, outgoingChannel]
      await adapter.save()

      const msgs = await adapter.receiveMessage(dmMessage)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].message).toBe('Hello bot, can you help me?')
      expect(msgs[0].source).toBe('zoom')
      expect(msgs[0].user).toEqual({ username: 'Alice Smith', dmConfig: { to: 102 } })
      expect(msgs[0].channels).toHaveLength(1)
      expect(msgs[0].channels[0].name).toBe('dm-both')
      expect(msgs[0].channels[0].direction).toBe(Direction.BOTH)
    })

    it('filters out OUTGOING channels from DM messages', async () => {
      await createConversation('Meeting with Only Outgoing DM Channels')
      conversation.enableDMs = ['agents']
      await conversation.save()

      const dmMessage = {
        data: {
          data: {
            data: {
              text: 'Hello bot, can you help me?',
              to: 'only_bot'
            },
            participant: {
              id: 102,
              name: 'Alice Smith',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      adapter.dmChannels = [{ name: 'dm-outgoing', direction: Direction.OUTGOING }]
      await adapter.save()

      const msgs = await adapter.receiveMessage(dmMessage)
      expect(msgs).toHaveLength(0)
    })

    it('does not process chat messages when no chatChannels configured', async () => {
      await createConversation('Meeting without Chat Channels')

      // Remove chatChannels from config
      adapter.config = {
        botId: 'test-bot-id-123',
        meetingUrl: 'http://zoom.meeting.com'
      }
      adapter.dmChannels = [{ name: 'participant' }]
      await adapter.save()

      const chatMessage = {
        data: {
          data: {
            data: {
              text: 'Hello everyone!',
              to: 'everyone'
            },
            participant: {
              id: 102,
              name: 'Alice Smith',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      const msgs = await adapter.receiveMessage(chatMessage)

      expect(msgs).toHaveLength(0)
    })

    it('does not process DM messages when no dmChannels configured', async () => {
      await createConversation('Meeting without DM Channels')

      // Remove dmChannels from config
      adapter.config = {
        botId: 'test-bot-id-123',
        meetingUrl: 'http://zoom.meeting.com'
      }
      adapter.chatChannels = [{ name: 'participant' }]
      await adapter.save()

      const chatMessage = {
        data: {
          data: {
            data: {
              text: 'Hello bot, can you help me?',
              to: 'only_bot'
            },
            participant: {
              id: 102,
              name: 'Alice Smith',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      const msgs = await adapter.receiveMessage(chatMessage)

      expect(msgs).toHaveLength(0)
    })

    describe('parent message matching for replies', () => {
      it('finds parent message when replying with exact quote match', async () => {
        await createConversation('Meeting with Reply Threading')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        // Create the original message
        const originalMessage = await Message.create({
          body: 'Can someone help with this task?',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Test User',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true
        })

        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "Can someone help with this task?" Sure, I can help!',
                to: 'everyone'
              },
              participant: {
                id: 102,
                name: 'Alice Smith',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        expect(msgs[0].parentMessage.toString()).toBe(originalMessage._id.toString())
      })

      it('sets parent to original message when original has no parent', async () => {
        await createConversation('Meeting with Simple Threading')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        const originalMessage = await Message.create({
          body: 'What is the status of the project?',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Test User',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true
        })

        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "What is the status of the project?" It is going well',
                to: 'everyone'
              },
              participant: {
                id: 103,
                name: 'Bob Johnson',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        expect(msgs[0].parentMessage.toString()).toBe(originalMessage._id.toString())
      })

      it('sets parent to original message parent when original has a parent', async () => {
        await createConversation('Meeting with Nested Threading')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        // Create the root message
        const rootMessage = await Message.create({
          body: 'Let us discuss the proposal',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Test User',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true
        })

        // Create a reply to the root message
        const firstReply = await Message.create({
          body: 'I agree with the proposal',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Test User 2',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true,
          parentMessage: rootMessage._id
        })

        // Reply to the first reply - should set parent to root message
        const secondReplyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "I agree with the proposal" Me too!',
                to: 'everyone'
              },
              participant: {
                id: 104,
                name: 'Charlie Brown',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(secondReplyMessage)
        expect(msgs).toHaveLength(1)
        expect(msgs[0].parentMessage.toString()).toBe(rootMessage._id.toString())
      })

      it('does not set parent when quote does not match any message', async () => {
        await createConversation('Meeting with No Match')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        await Message.create({
          body: 'This is a different message',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Test User',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true
        })

        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "This quote does not exist" I disagree',
                to: 'everyone'
              },
              participant: {
                id: 105,
                name: 'Dana White',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        expect(msgs[0].parentMessage).toBeUndefined()
      })

      it('only searches messages within the last hour', async () => {
        await createConversation('Meeting with Old Messages')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        // Create an old message (2 hours ago)
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
        await Message.create({
          body: 'This is an old message',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Test User',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true,
          createdAt: twoHoursAgo
        })

        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "This is an old message" I found it!',
                to: 'everyone'
              },
              participant: {
                id: 106,
                name: 'Eve Anderson',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        // Should not find the old message
        expect(msgs[0].parentMessage).toBeUndefined()
      })

      it('only searches messages on the same channels', async () => {
        await createConversation('Meeting with Multiple Channels')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        // Create message on different channel
        await Message.create({
          body: 'This is on a different channel',
          conversation: conversation._id,
          channels: ['other-channel'],
          pseudonym: 'Test User',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true
        })

        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "This is on a different channel" Yes!',
                to: 'everyone'
              },
              participant: {
                id: 107,
                name: 'Frank Miller',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        // Should not find message on different channel
        expect(msgs[0].parentMessage).toBeUndefined()
      })

      it('finds parent message for DM replies', async () => {
        await createConversation('Meeting with DM Threading')
        const Message = (await import('../../src/models/message.model.js')).default
        conversation.enableDMs = ['agents']
        await conversation.save()

        const agentId = new mongoose.Types.ObjectId()
        adapter.dmChannels = [{ name: 'dm-channel', direction: Direction.INCOMING }]
        await adapter.save()

        const originalMessage = await Message.create({
          body: 'Can you help me privately?',
          conversation: conversation._id,
          channels: ['dm-channel'],
          pseudonym: 'Test User',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true
        })

        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "Can you help me privately?" Of course!',
                to: 'only_bot'
              },
              participant: {
                id: 108,
                name: 'Grace Lee',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        expect(msgs[0].parentMessage.toString()).toBe(originalMessage._id.toString())
      })

      it('finds most recent message when multiple matches exist', async () => {
        await createConversation('Meeting with Multiple Matches')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        // Create two messages with similar content
        await Message.create({
          body: 'I need help with this',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Test User',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true,
          createdAt: new Date(Date.now() - 10 * 60 * 1000) // 10 minutes ago
        })

        const recentMessage = await Message.create({
          body: 'I need help with this',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Test User 2',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true,
          createdAt: new Date(Date.now() - 1 * 60 * 1000) // 1 minute ago
        })

        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "I need help with this" Sure thing!',
                to: 'everyone'
              },
              participant: {
                id: 109,
                name: 'Henry Ford',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        // Should match the most recent message
        expect(msgs[0].parentMessage.toString()).toBe(recentMessage._id.toString())
      })

      it('finds parent message when quote is truncated at 50 characters by Recall', async () => {
        await createConversation('Meeting with Truncated Reply')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        // Create a long original message (more than 50 characters)
        const longMessage =
          'Can someone please help me understand the details of this complicated project requirement and how we should proceed?'
        const originalMessage = await Message.create({
          body: longMessage,
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Test User',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true
        })

        // Recall truncates the quote at ~50 characters
        const truncatedQuote = 'Can someone please help me understand the details'
        const replyMessage = {
          data: {
            data: {
              data: {
                text: `Replying to "${truncatedQuote}" Yes, I can help with that!`,
                to: 'everyone'
              },
              participant: {
                id: 110,
                name: 'Isabel Martinez',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        // Should still find the parent message via substring matching
        expect(msgs[0].parentMessage.toString()).toBe(originalMessage._id.toString())
      })

      it('handles partial quote with special regex characters', async () => {
        await createConversation('Meeting with Special Characters')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        const originalMessage = await Message.create({
          body: 'What does the function calculateTotal() do? Can you explain the logic behind it?',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Test User',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true
        })

        // Truncated quote containing parentheses (special regex chars)
        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "What does the function calculateTotal() do? Can yo" It calculates the total amount',
                to: 'everyone'
              },
              participant: {
                id: 111,
                name: 'Jack Wilson',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        // Should properly escape regex special characters and still find the match
        expect(msgs[0].parentMessage.toString()).toBe(originalMessage._id.toString())
      })

      it('strips robot emoji from quoted portion when matching agent messages', async () => {
        await createConversation('Meeting with Agent Message Reply')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        // Create an agent message (what was sent to Zoom with emoji)
        const originalMessage = await Message.create({
          body: 'I can help you with that task',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Agent',
          pseudonymId: new mongoose.Types.ObjectId(),
          fromAgent: true,
          source: 'zoom',
          visible: true
        })

        // Zoom reply includes the robot emoji in the quote
        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "🤖 I can help you with that task" Thank you!',
                to: 'everyone'
              },
              participant: {
                id: 112,
                name: 'Kelly White',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        expect(msgs[0].message).toBe('Thank you!')
        // Should match by stripping the emoji
        expect(msgs[0].parentMessage.toString()).toBe(originalMessage._id.toString())
      })

      it('strips person emoji and pseudonym from quoted portion when matching user messages', async () => {
        await createConversation('Meeting with User Message Reply')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        // Create a user message (original body without icon/pseudonym)
        const originalMessage = await Message.create({
          body: 'This is a great idea',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Fun Frog',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true
        })

        // Zoom reply includes the person emoji and pseudonym in the quote
        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "👤 Fun Frog: This is a great idea" I agree!',
                to: 'everyone'
              },
              participant: {
                id: 113,
                name: 'Larry King',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        expect(msgs[0].message).toBe('I agree!')
        // Should match by stripping the emoji and pseudonym
        expect(msgs[0].parentMessage.toString()).toBe(originalMessage._id.toString())
      })

      it('strips truncated pseudonym from quoted portion when not ending with ...', async () => {
        await createConversation('Meeting with Truncated Pseudonym')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        // Create a user message with a long body
        const originalMessage = await Message.create({
          body: 'Can someone help me understand how this feature works and what the best approach is?',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Very Long Pseudonym Name',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true
        })

        // Zoom quote is truncated at ~50 chars and includes emoji + pseudonym (no ... yet)
        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "👤 Very Long Pseudonym Name: Can someone help me un" Sure!',
                to: 'everyone'
              },
              participant: {
                id: 114,
                name: 'Mary Johnson',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        expect(msgs[0].message).toBe('Sure!')
        // Should match by stripping emoji/pseudonym and matching the partial quote
        expect(msgs[0].parentMessage.toString()).toBe(originalMessage._id.toString())
      })

      it('matches by pseudonym when quote is severely truncated with ... (only first letter)', async () => {
        await createConversation('Meeting with Severely Truncated Quote')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        // Create a user message
        const originalMessage = await Message.create({
          body: 'This is an important message about the project',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Fun Frog',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true
        })

        // Zoom severely truncates: only first letter after pseudonym, ends with ...
        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "👤 Fun Frog: T..." I agree!',
                to: 'everyone'
              },
              participant: {
                id: 115,
                name: 'Nancy Drew',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        expect(msgs[0].message).toBe('I agree!')
        // Should match by pseudonym since quote ends with ... and has pseudonym
        expect(msgs[0].parentMessage.toString()).toBe(originalMessage._id.toString())
      })

      it('matches most recent message by pseudonym when multiple messages exist', async () => {
        await createConversation('Meeting with Multiple Messages from Same Pseudonym')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        // Create older message from same pseudonym
        await Message.create({
          body: 'First message from user',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Cool Cat',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true,
          createdAt: new Date(Date.now() - 10 * 60 * 1000) // 10 minutes ago
        })

        // Create more recent message from same pseudonym
        const recentMessage = await Message.create({
          body: 'Second message from same user',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Cool Cat',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true,
          createdAt: new Date(Date.now() - 1 * 60 * 1000) // 1 minute ago
        })

        // Reply with severely truncated quote
        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "👤 Cool Cat: S..." Great point!',
                to: 'everyone'
              },
              participant: {
                id: 116,
                name: 'Oliver Stone',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        expect(msgs[0].message).toBe('Great point!')
        // Should match the most recent message from that pseudonym
        expect(msgs[0].parentMessage.toString()).toBe(recentMessage._id.toString())
      })

      it('matches by pseudonym only when truncated, not for full quotes', async () => {
        await createConversation('Meeting with Full vs Truncated Quotes')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        // Create two messages from same pseudonym
        const olderMessage = await Message.create({
          body: 'This is the first message',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Happy Hippo',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true,
          createdAt: new Date(Date.now() - 5 * 60 * 1000)
        })

        await Message.create({
          body: 'This is a different message',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Happy Hippo',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true,
          createdAt: new Date(Date.now() - 1 * 60 * 1000)
        })

        // Reply with full quote (no truncation)
        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "👤 Happy Hippo: This is the first message" Exactly!',
                to: 'everyone'
              },
              participant: {
                id: 117,
                name: 'Patricia Hill',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        expect(msgs[0].message).toBe('Exactly!')
        // Should match by content, not just pseudonym (picks the specific message)
        expect(msgs[0].parentMessage.toString()).toBe(olderMessage._id.toString())
      })

      it('only matches messages that start with the quoted text, not contain', async () => {
        await createConversation('Meeting with Start vs Contains')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        // Create message that contains the text but doesn't start with it
        await Message.create({
          body: 'I think the answer is important here',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Test User',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true
        })

        // Create message that starts with the text
        const correctMessage = await Message.create({
          body: 'important here is the key point',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Test User 2',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true
        })

        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "important here" I agree!',
                to: 'everyone'
              },
              participant: {
                id: 118,
                name: 'Quinn Adams',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        // Should match the message that STARTS with the text
        expect(msgs[0].parentMessage.toString()).toBe(correctMessage._id.toString())
      })

      it('does not match by pseudonym if truncated text does not match message start', async () => {
        await createConversation('Meeting with Mismatched Truncated Quote')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        // Create message from pseudonym that doesn't match the truncated quote
        await Message.create({
          body: 'This is completely different text',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Clever Cat',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true
        })

        // Reply with truncated quote that doesn't match the actual message start
        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "👤 Clever Cat: Some other t..." No way!',
                to: 'everyone'
              },
              participant: {
                id: 119,
                name: 'Rachel Green',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        expect(msgs[0].message).toBe('No way!')
        // Should not find a match since "Some other t" doesn't match message start
        expect(msgs[0].parentMessage).toBeUndefined()
      })

      it('matches correct message by pseudonym when truncated text matches start', async () => {
        await createConversation('Meeting with Correct Truncated Match')
        const Message = (await import('../../src/models/message.model.js')).default

        adapter.chatChannels = [{ name: 'participant', direction: Direction.INCOMING }]
        await adapter.save()

        // Create older message from same pseudonym
        await Message.create({
          body: 'Different message entirely',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Busy Bee',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true,
          createdAt: new Date(Date.now() - 10 * 60 * 1000)
        })

        // Create recent message that matches the truncated quote
        const matchingMessage = await Message.create({
          body: 'This is the correct message',
          conversation: conversation._id,
          channels: ['participant'],
          pseudonym: 'Busy Bee',
          pseudonymId: new mongoose.Types.ObjectId(),
          owner: user1._id,
          source: 'zoom',
          visible: true,
          createdAt: new Date(Date.now() - 1 * 60 * 1000)
        })

        // Reply with truncated quote that matches the second message start
        const replyMessage = {
          data: {
            data: {
              data: {
                text: 'Replying to "👤 Busy Bee: This is the c..." Perfect!',
                to: 'everyone'
              },
              participant: {
                id: 120,
                name: 'Sam Wilson',
                is_host: false,
                platform: 'zoom'
              }
            }
          },
          event: 'participant_events.chat_message'
        }

        const msgs = await adapter.receiveMessage(replyMessage)
        expect(msgs).toHaveLength(1)
        expect(msgs[0].message).toBe('Perfect!')
        // Should match the message where pseudonym AND partial text both match
        expect(msgs[0].parentMessage.toString()).toBe(matchingMessage._id.toString())
      })
    })
  })

  describe('sendMessage', () => {
    beforeEach(() => {
      ;(fetch as jest.Mock).mockClear()
    })

    it('successfully sends direct message', async () => {
      await createConversation('Test Meeting with Direct Channel')
      conversation.enableDMs = ['agents']

      const agentId = new mongoose.Types.ObjectId()
      adapter.dmChannels = [
        { name: 'participant' },
        { direct: true, agent: agentId, direction: Direction.BOTH, config: { direct1: { to: 'Alice Smith' } } }
      ]

      const mockResponse = {
        status: httpStatus.OK,
        json: jest.fn().mockResolvedValue({ success: true })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      const message = {
        body: 'Direct message to Alice',
        channels: ['direct1']
      }

      await adapter.sendMessage(message)

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(`${config.recall.baseUrl}/test-bot-id-123/send_chat_message/`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: JSON.stringify({
          message: 'Direct message to Alice',
          to: 'Alice Smith'
        })
      })
    })

    it('successfully sends non-direct message', async () => {
      await createConversation('Test Meeting with Group Channel')
      conversation.enableDMs = ['agents']

      const mockResponse = {
        status: httpStatus.OK,
        json: jest.fn().mockResolvedValue({ success: true })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      adapter.chatChannels = [{ name: 'participant', direction: Direction.OUTGOING }]

      const message = {
        body: 'Hello everyone!',
        channels: ['participant'],
        pseudonym: 'Tricky Turtle'
      }

      await adapter.sendMessage(message)

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(`${config.recall.baseUrl}/test-bot-id-123/send_chat_message/`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: JSON.stringify({
          message: '👤 Tricky Turtle: Hello everyone!'
        })
      })
    })

    it('throws error when API returns non-200 status', async () => {
      await createConversation('Test Meeting')

      adapter.chatChannels = [{ name: 'participant', direction: Direction.OUTGOING }]

      const mockResponse = {
        status: httpStatus.BAD_REQUEST,
        text: jest.fn().mockResolvedValue('Bad Request')
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      const message = {
        body: 'Test message',
        channels: ['participant']
      }

      await expect(adapter.sendMessage(message)).rejects.toThrow('Error sending chat message to Zoom meeting: 400')
    })

    it('handles network errors gracefully', async () => {
      await createConversation('Test Meeting')
      ;(fetch as jest.Mock).mockRejectedValue(new Error('Network error'))

      adapter.chatChannels = [{ name: 'participant', direction: Direction.OUTGOING }]

      const message = {
        body: 'Test message',
        channels: ['participant']
      }

      await expect(adapter.sendMessage(message)).rejects.toThrow('Network error')
    })

    it('prepends pseudonym to group chat messages from participants', async () => {
      await createConversation('Test Meeting with Pseudonyms')
      const mockResponse = {
        status: httpStatus.OK,
        json: jest.fn().mockResolvedValue({ success: true })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      adapter.chatChannels = [{ name: 'participant', direction: Direction.OUTGOING }]

      const message = {
        body: 'Hello everyone!',
        pseudonym: 'Busy Beaver',
        fromAgent: false,
        channels: ['participant']
      }

      await adapter.sendMessage(message)

      expect(fetch).toHaveBeenCalledWith(`${config.recall.baseUrl}/test-bot-id-123/send_chat_message/`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: JSON.stringify({
          message: '👤 Busy Beaver: Hello everyone!'
        })
      })
    })

    it('does not prepend pseudonym to direct messages', async () => {
      await createConversation('Test Meeting with DM')
      const mockResponse = {
        status: httpStatus.OK,
        json: jest.fn().mockResolvedValue({ success: true })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      const agentId = new mongoose.Types.ObjectId()
      adapter.dmChannels = [
        { name: 'participant' },
        { direct: true, agent: agentId, direction: Direction.BOTH, config: { direct1: { to: 'Alice Smith' } } }
      ]

      const message = {
        body: 'Direct message to Alice',
        pseudonym: 'Busy Beaver',
        fromAgent: false,
        channels: ['direct1']
      }

      await adapter.sendMessage(message, { to: 'Alice Smith' })

      expect(fetch).toHaveBeenCalledWith(`${config.recall.baseUrl}/test-bot-id-123/send_chat_message/`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: JSON.stringify({
          message: 'Direct message to Alice',
          to: 'Alice Smith'
        })
      })
    })

    it('prepends robot emoji to messages from agents in group chat', async () => {
      await createConversation('Test Meeting with Agent Messages')
      const mockResponse = {
        status: httpStatus.OK,
        json: jest.fn().mockResolvedValue({ success: true })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      adapter.chatChannels = [{ name: 'participant', direction: Direction.OUTGOING }]

      const message = {
        body: 'Hello from the agent!',
        pseudonym: 'Smart Agent',
        fromAgent: true,
        channels: ['participant']
      }

      await adapter.sendMessage(message)

      expect(fetch).toHaveBeenCalledWith(`${config.recall.baseUrl}/test-bot-id-123/send_chat_message/`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: JSON.stringify({
          message: '🤖 Hello from the agent!'
        })
      })
    })

    it('does not prepend pseudonym to messages from agents in direct messages', async () => {
      await createConversation('Test Meeting with Agent DMs')
      const mockResponse = {
        status: httpStatus.OK,
        json: jest.fn().mockResolvedValue({ success: true })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      const agentId = new mongoose.Types.ObjectId()
      adapter.dmChannels = [
        { name: 'participant' },
        { direct: true, agent: agentId, direction: Direction.BOTH, config: { direct1: { to: 'Bob Jones' } } }
      ]

      const message = {
        body: 'Agent DM to Bob',
        pseudonym: 'Smart Agent',
        fromAgent: true,
        channels: ['direct1']
      }

      await adapter.sendMessage(message, { to: 'Bob Jones' })

      expect(fetch).toHaveBeenCalledWith(`${config.recall.baseUrl}/test-bot-id-123/send_chat_message/`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: JSON.stringify({
          message: 'Agent DM to Bob',
          to: 'Bob Jones'
        })
      })
    })
  })

  describe('start method', () => {
    beforeEach(() => {
      ;(fetch as jest.Mock).mockClear()
    })

    it('successfully deploys meeting bot with basic configuration and no audioChannels', async () => {
      await createConversation('Basic Meeting')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/123456789'
      }
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]
      adapter.active = false
      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      const mockResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'new-bot-id-123' })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      await adapter.start()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(config.recall.baseUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: JSON.stringify({
          meeting_url: 'https://zoom.us/j/123456789',
          bot_name: 'LLM Engine',
          automatic_leave: {
            bot_detection: {
              using_participant_events: {
                timeout: 999999,
                activate_after: 999999
              }
            },
            everyone_left_timeout: {
              timeout: 2,
              activate_after: 1
            },
            waiting_room_timeout: 1200,
            noone_joined_timeout: 1200,
            in_call_not_recording_timeout: 3600,
            recording_permission_denied_timeout: 30
          },
          recording_config: {
            realtime_endpoints: [
              {
                type: 'webhook',
                events: ['participant_events.chat_message'],
                url: `${config.recall.endpointBaseUrl}/v1/webhooks/recall/chat/?conversationId=${conversation._id}`
              },
              {
                type: 'webhook',
                events: ['participant_events.join'],
                url: `${config.recall.endpointBaseUrl}/v1/webhooks/recall/join/?conversationId=${conversation._id}`
              }
            ],
            retention: {
              type: 'timed',
              hours: 168
            }
          },
          ...(config.zoom?.webinarUserEmail && {
            zoom: {
              user_email: config.zoom.webinarUserEmail
            }
          })
        })
      })

      // Check that bot ID was saved to adapter config
      expect(adapter.config.botId).toBe('new-bot-id-123')
    })

    it('successfully deploys meeting bot with custom retention policy', async () => {
      await createConversation('Basic Meeting')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/123456789',
        retention: null
      }
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]
      adapter.active = false
      const channel = await Channel.create({ name: 'participant', adapterConfigs: [{ adapter: adapter._id }] })
      conversation.channels.push(channel)
      await conversation.save()

      const mockResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'new-bot-id-123' })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      await adapter.start()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(config.recall.baseUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: JSON.stringify({
          meeting_url: 'https://zoom.us/j/123456789',
          bot_name: 'LLM Engine',
          automatic_leave: {
            bot_detection: {
              using_participant_events: {
                timeout: 999999,
                activate_after: 999999
              }
            },
            everyone_left_timeout: {
              timeout: 2,
              activate_after: 1
            },
            waiting_room_timeout: 1200,
            noone_joined_timeout: 1200,
            in_call_not_recording_timeout: 3600,
            recording_permission_denied_timeout: 30
          },
          recording_config: {
            realtime_endpoints: [
              {
                type: 'webhook',
                events: ['participant_events.chat_message'],
                url: `${config.recall.endpointBaseUrl}/v1/webhooks/recall/chat/?conversationId=${conversation._id}`
              },
              {
                type: 'webhook',
                events: ['participant_events.join'],
                url: `${config.recall.endpointBaseUrl}/v1/webhooks/recall/join/?conversationId=${conversation._id}`
              }
            ],
            retention: null
          },
          ...(config.zoom?.webinarUserEmail && {
            zoom: {
              user_email: config.zoom.webinarUserEmail
            }
          })
        })
      })
    })

    it('deploys bot with transcript configuration when audioChannels are specified and channels exist', async () => {
      await createConversation('Meeting with Transcript')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/987654321'
      }
      adapter.audioChannels = [{ name: 'transcript' }]
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]

      const channels = await Channel.create([{ name: 'transcript' }, { name: 'participant' }])
      conversation.channels.push(...channels)
      await conversation.save()

      const mockResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'transcript-bot-456' })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      await adapter.start()

      expect(fetch).toHaveBeenCalledWith(config.recall.baseUrl, expect.objectContaining({ method: 'POST' }))
      expect(adapter.config.botId).toBe('transcript-bot-456')
    })

    it('does not enable transcription when audioChannels are specified but channels do not exist on conversation', async () => {
      await createConversation('Meeting with Missing Audio Channels')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/987654321'
      }
      adapter.audioChannels = [{ name: 'transcript' }]
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      const mockResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'no-transcript-bot-789' })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      await adapter.start()

      expect(fetch).toHaveBeenCalledWith(config.recall.baseUrl, expect.objectContaining({ method: 'POST' }))
      expect(adapter.config.botId).toBe('no-transcript-bot-789')
    })

    it('throws error when API returns non-201 status', async () => {
      await createConversation('Failed Deployment')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/invalid'
      }
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      const mockResponse = {
        status: httpStatus.BAD_REQUEST,
        text: jest.fn().mockResolvedValue('Invalid meeting URL')
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      await expect(adapter.start()).rejects.toThrow('Error deploying bot to Zoom meeting: 400')
      expect(adapter.config.botId).toBeUndefined()
    })

    it('enables transcription with multiple audioChannels when all exist on conversation', async () => {
      await createConversation('Meeting with Multiple Audio Channels')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/987654321'
      }
      adapter.audioChannels = [{ name: 'transcript' }, { name: 'audio-log' }]
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]

      const channels = await Channel.create([{ name: 'transcript' }, { name: 'audio-log' }, { name: 'participant' }])
      conversation.channels.push(...channels)
      await conversation.save()

      const mockResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'multi-audio-bot-123' })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      await adapter.start()

      expect(fetch).toHaveBeenCalledWith(config.recall.baseUrl, expect.objectContaining({ method: 'POST' }))
      expect(adapter.config.botId).toBe('multi-audio-bot-123')
    })
    // Add these test cases to the existing 'start method' describe block

    it('skips deployment when bot is already deployed and active', async () => {
      await createConversation('Meeting with Active Bot')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/123456789',
        botId: 'existing-bot-123'
      }
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]
      adapter.active = false

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      // Mock successful bot status check
      const mockStatusResponse = {
        status: httpStatus.OK,
        json: jest.fn().mockResolvedValue({
          status_changes: [
            { code: 'in_waiting_room', timestamp: '2024-01-01T10:00:00Z' },
            { code: 'in_call', timestamp: '2024-01-01T10:01:00Z' }
          ]
        })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockStatusResponse)

      await adapter.start()

      // Should only call fetch once for status check, not for deployment
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(`${config.recall.baseUrl}/existing-bot-123`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          Authorization: config.recall.key
        }
      })

      // Bot ID should remain unchanged
      expect(adapter.config.botId).toBe('existing-bot-123')
    })

    it('redeploys bot when existing bot status is "done"', async () => {
      await createConversation('Meeting with Done Bot')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/123456789',
        botId: 'done-bot-456'
      }
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]
      adapter.active = false

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      // Mock bot status check showing "done" status
      const mockStatusResponse = {
        status: httpStatus.OK,
        json: jest.fn().mockResolvedValue({
          status_changes: [
            { code: 'in_call', timestamp: '2024-01-01T10:00:00Z' },
            { code: 'done', timestamp: '2024-01-01T10:30:00Z' }
          ]
        })
      }

      // Mock successful deployment response
      const mockDeployResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'new-bot-789' })
      }

      ;(fetch as jest.Mock).mockResolvedValueOnce(mockStatusResponse).mockResolvedValueOnce(mockDeployResponse)

      await adapter.start()

      // Should call fetch twice: once for status check, once for deployment
      expect(fetch).toHaveBeenCalledTimes(2)

      // First call should be status check
      expect(fetch).toHaveBeenNthCalledWith(1, `${config.recall.baseUrl}/done-bot-456`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          Authorization: config.recall.key
        }
      })

      // Second call should be deployment
      expect(fetch).toHaveBeenNthCalledWith(2, config.recall.baseUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: expect.stringContaining('"meeting_url":"https://zoom.us/j/123456789"')
      })

      // Bot ID should be updated to new bot
      expect(adapter.config.botId).toBe('new-bot-789')
    })

    it('redeploys bot when status check returns non-200 status', async () => {
      await createConversation('Meeting with Unreachable Bot')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/555666777',
        botId: 'unreachable-bot-404'
      }
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      // Mock failed status check
      const mockStatusResponse = {
        status: httpStatus.NOT_FOUND,
        text: jest.fn().mockResolvedValue('Bot not found')
      }

      const mockDeployResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'recovery-bot-222' })
      }

      ;(fetch as jest.Mock).mockResolvedValueOnce(mockStatusResponse).mockResolvedValueOnce(mockDeployResponse)

      await adapter.start()

      expect(fetch).toHaveBeenCalledTimes(2)
      expect(adapter.config.botId).toBe('recovery-bot-222')
    })
  })
  describe('stop method', () => {
    beforeEach(() => {
      ;(fetch as jest.Mock).mockClear()
    })

    it('successfully removes bot from Zoom meeting', async () => {
      await createConversation('Test Meeting for Stop')
      adapter.config.botId = 'active-bot-id-123'

      const mockResponse = {
        status: httpStatus.OK,
        text: jest.fn().mockResolvedValue('Bot removed successfully')
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      await adapter.stop()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(`${config.recall.baseUrl}/active-bot-id-123/leave_call/`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        }
      })
      // Ensure botId has been removed from config
      expect(adapter.config.botId).toBeUndefined()
    })

    it('logs error when API returns non-200 status but does not throw', async () => {
      await createConversation('Test Meeting for Failed Stop')
      adapter.config.botId = 'failed-bot-id-456'

      const mockResponse = {
        status: httpStatus.BAD_REQUEST,
        text: jest.fn().mockResolvedValue('Bot not found in meeting')
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation()

      // Should not throw an error
      await expect(adapter.stop()).resolves.toBeUndefined()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(loggerSpy).toHaveBeenCalledWith(
        'Error removing bot from Zoom meeting: 400. Recall error: Bot not found in meeting'
      )

      loggerSpy.mockRestore()
    })
  })

  describe('pauseTranscript', () => {
    beforeEach(() => {
      ;(fetch as jest.Mock).mockClear()
    })

    it('successfully pauses recording', async () => {
      await createConversation('Test Meeting for Pause Recording')
      adapter.config.botId = 'active-bot-id-123'

      const mockResponse = {
        status: httpStatus.OK,
        text: jest.fn().mockResolvedValue('Recording paused successfully')
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      await adapter.pauseTranscript()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(`${config.recall.baseUrl}/active-bot-id-123/pause_recording/`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        }
      })
    })

    it('throws error when API returns non-200 status', async () => {
      await createConversation('Test Meeting for Failed Pause')
      adapter.config.botId = 'failed-bot-id-456'

      const mockResponse = {
        status: httpStatus.BAD_REQUEST,
        text: jest.fn().mockResolvedValue('Cannot pause recording')
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation()

      await expect(adapter.pauseTranscript()).rejects.toThrow('Error pausing recording: 400')

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(loggerSpy).toHaveBeenCalledWith('Error pausing recording: 400. Recall error: Cannot pause recording')

      loggerSpy.mockRestore()
    })
  })

  describe('resumeTranscript', () => {
    beforeEach(() => {
      ;(fetch as jest.Mock).mockClear()
    })

    it('successfully resumes recording when bot is deployed', async () => {
      await createConversation('Test Meeting for Resume Recording')
      adapter.config.botId = 'active-bot-id-789'

      // Mock bot status check to return active
      const mockStatusResponse = {
        status: httpStatus.OK,
        json: jest.fn().mockResolvedValue({
          status_changes: [{ code: 'in_call', timestamp: '2024-01-01T10:00:00Z' }]
        })
      }

      const mockResumeResponse = {
        status: httpStatus.OK,
        text: jest.fn().mockResolvedValue('Recording resumed successfully')
      }

      ;(fetch as jest.Mock).mockResolvedValueOnce(mockStatusResponse).mockResolvedValueOnce(mockResumeResponse)

      await adapter.resumeTranscript()

      expect(fetch).toHaveBeenCalledTimes(2)
      // First call is status check
      expect(fetch).toHaveBeenNthCalledWith(1, `${config.recall.baseUrl}/active-bot-id-789`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          Authorization: config.recall.key
        }
      })
      // Second call is resume
      expect(fetch).toHaveBeenNthCalledWith(2, `${config.recall.baseUrl}/active-bot-id-789/resume_recording/`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        }
      })
    })

    it('deploys bot and returns without resuming when bot is not deployed', async () => {
      await createConversation('Test Meeting with No Bot')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/123456789'
      }
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      const mockDeployResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'new-bot-id-123' })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockDeployResponse)

      await adapter.resumeTranscript()

      // Should only call fetch once for deployment, not for resume
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(config.recall.baseUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: expect.stringContaining('"meeting_url":"https://zoom.us/j/123456789"')
      })

      // Bot ID should be updated
      expect(adapter.config.botId).toBe('new-bot-id-123')
    })

    it('deploys bot and returns without resuming when bot is inactive', async () => {
      await createConversation('Test Meeting with Inactive Bot')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/123456789',
        botId: 'inactive-bot-456'
      }
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      // Mock bot status check showing bot is done
      const mockStatusResponse = {
        status: httpStatus.OK,
        json: jest.fn().mockResolvedValue({
          status_changes: [
            { code: 'in_call', timestamp: '2024-01-01T10:00:00Z' },
            { code: 'done', timestamp: '2024-01-01T10:30:00Z' }
          ]
        })
      }

      const mockDeployResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'new-bot-789' })
      }

      ;(fetch as jest.Mock).mockResolvedValueOnce(mockStatusResponse).mockResolvedValueOnce(mockDeployResponse)

      await adapter.resumeTranscript()

      // Should call fetch twice: status check and deployment, but not resume
      expect(fetch).toHaveBeenCalledTimes(2)

      // First call is status check
      expect(fetch).toHaveBeenNthCalledWith(1, `${config.recall.baseUrl}/inactive-bot-456`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          Authorization: config.recall.key
        }
      })

      // Second call is deployment
      expect(fetch).toHaveBeenNthCalledWith(2, config.recall.baseUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: expect.stringContaining('"meeting_url":"https://zoom.us/j/123456789"')
      })

      // Bot ID should be updated
      expect(adapter.config.botId).toBe('new-bot-789')
    })

    it('throws error when API returns non-200 status', async () => {
      await createConversation('Test Meeting for Failed Resume')
      adapter.config.botId = 'failed-bot-id-999'

      // Mock bot status check to return active
      const mockStatusResponse = {
        status: httpStatus.OK,
        json: jest.fn().mockResolvedValue({
          status_changes: [{ code: 'in_call', timestamp: '2024-01-01T10:00:00Z' }]
        })
      }

      const mockResumeResponse = {
        status: httpStatus.INTERNAL_SERVER_ERROR,
        text: jest.fn().mockResolvedValue('Cannot resume recording')
      }

      ;(fetch as jest.Mock).mockResolvedValueOnce(mockStatusResponse).mockResolvedValueOnce(mockResumeResponse)

      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation()

      await expect(adapter.resumeTranscript()).rejects.toThrow('Error resuming recording: 500')

      expect(fetch).toHaveBeenCalledTimes(2)
      expect(loggerSpy).toHaveBeenCalledWith('Error resuming recording: 500. Recall error: Cannot resume recording')

      loggerSpy.mockRestore()
    })
  })

  describe('participantJoined', () => {
    it('configures user and direct channel when DMs are enabled', async () => {
      await createConversation('Meeting with DMs Enabled')
      conversation.enableDMs = ['agents']

      adapter.dmChannels = [{ direct: true, agent: new mongoose.Types.ObjectId(), direction: Direction.BOTH }]
      await adapter.save()

      const participant = {
        id: 200,
        name: 'New Joiner',
        is_host: false,
        platform: 'zoom'
      }

      const adapterUser = await adapter.participantJoined(participant)
      expect(adapterUser).toEqual({ username: 'New Joiner', dmConfig: { to: 200 } })
    })

    it('does not configure direct channel when DMs are not enabled', async () => {
      await createConversation('Meeting without DMs')

      // DMs not enabled - conversation.enableDMs defaults to empty array

      const participant = {
        id: 400,
        name: 'No DM User',
        is_host: false,
        platform: 'zoom'
      }

      const adapterUser = await adapter.participantJoined(participant)

      expect(adapterUser).toBeUndefined()
    })

    it('does not configure direct channel when participant is the default bot', async () => {
      await createConversation('Meeting with Default Bot')
      conversation.enableDMs = ['agents']

      adapter.dmChannels = [{ direct: true, agent: new mongoose.Types.ObjectId() }]
      await adapter.save()

      const botParticipant = {
        id: 600,
        name: 'LLM Engine', // This is the defaultBotName
        is_host: false,
        platform: 'zoom'
      }

      const adapterUser = await adapter.participantJoined(botParticipant)

      expect(adapterUser).toBeUndefined()
    })

    it('does not process participantJoined when participant is a configured bot', async () => {
      await createConversation('Meeting with Custom Bot Name')
      conversation.enableDMs = ['agents']

      // Create another adapter with custom bot name
      const adapter2 = await Adapter.create({
        type: 'zoom',
        conversation,
        config: {
          botId: 'custom-bot-id-789',
          meetingUrl: 'http://zoom.meeting.com',
          botName: 'Custom Meeting Assistant'
        },
        active: true
      })
      conversation.adapters.push(adapter2)
      await conversation.save()

      adapter.dmChannels = [{ direct: true, agent: new mongoose.Types.ObjectId() }]
      await adapter.save()

      const customBotParticipant = {
        id: 700,
        name: 'Custom Meeting Assistant', // This matches the configured botName
        is_host: false,
        platform: 'zoom'
      }
      const adapterUser = await adapter.participantJoined(customBotParticipant)
      expect(adapterUser).toBeUndefined()
    })
  })
  describe('validateBeforeUpdate method', () => {
    beforeEach(async () => {
      // Clean up any existing conversations
      await Conversation.deleteMany({})
      await Adapter.deleteMany({})
    })

    it('throws error when no meeting URL is specified in adapter config', async () => {
      await createConversation('Test Meeting')
      adapter.config = { botId: 'test-bot-id-123' }

      await expect(adapter.save()).rejects.toThrow('Zoom meeting URL required in adapter config')
    })
  })
})
