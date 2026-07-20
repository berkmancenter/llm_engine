import httpStatus from 'http-status'
import resolveConversationType from '../../src/conversations/resolver.js'
import { ConversationType, Direction } from '../../src/types/index.types.js'

// Minimal conversation type used across most tests
const baseType: ConversationType = {
  name: 'test',
  description: 'test type',
  platforms: [{ name: 'zoom' }, { name: 'web' }],
  properties: [
    { name: 'requiredProp', required: true, type: 'string' },
    { name: 'optionalProp', required: false, type: 'string', default: 'default-value' },
    { name: 'noDefault', required: false, type: 'string' }
  ]
}

describe('resolveConversationType', () => {
  describe('property validation', () => {
    test('throws BAD_REQUEST when a required property is missing', () => {
      expect(() => resolveConversationType({ properties: {} }, baseType)).toThrow(
        expect.objectContaining({
          statusCode: httpStatus.BAD_REQUEST,
          message: "Required property 'requiredProp' is missing"
        })
      )
    })

    test('throws BAD_REQUEST for an invalid enum value', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [
          {
            name: 'model',
            required: false,
            type: 'enum',
            options: [
              { llmPlatform: 'openai', llmModel: 'gpt-4' },
              { llmPlatform: 'openai', llmModel: 'gpt-3.5-turbo' }
            ],
            validationKeys: ['llmPlatform', 'llmModel']
          }
        ]
      }
      expect(() =>
        resolveConversationType({ properties: { model: { llmPlatform: 'openai', llmModel: 'not-a-model' } } }, type)
      ).toThrow(expect.objectContaining({ statusCode: httpStatus.BAD_REQUEST }))
    })

    test('accepts a valid enum value', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [
          {
            name: 'model',
            required: false,
            type: 'enum',
            options: [{ llmPlatform: 'openai', llmModel: 'gpt-4' }],
            validationKeys: ['llmPlatform', 'llmModel']
          }
        ]
      }
      expect(() =>
        resolveConversationType({ properties: { model: { llmPlatform: 'openai', llmModel: 'gpt-4' } } }, type)
      ).not.toThrow()
    })

    test('throws BAD_REQUEST for an invalid object key', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [
          {
            name: 'categories',
            required: false,
            type: 'object',
            schema: [{ name: 'tech' }, { name: 'science' }]
          }
        ]
      }
      expect(() => resolveConversationType({ properties: { categories: { tech: {}, unknown: {} } } }, type)).toThrow(
        expect.objectContaining({ statusCode: httpStatus.BAD_REQUEST })
      )
    })

    test('throws BAD_REQUEST when an object property is not an object', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [{ name: 'categories', required: false, type: 'object', schema: [{ name: 'tech' }] }]
      }
      expect(() => resolveConversationType({ properties: { categories: 'not-an-object' } }, type)).toThrow(
        expect.objectContaining({ statusCode: httpStatus.BAD_REQUEST })
      )
    })

    test('throws BAD_REQUEST when a value fails its declared format', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [{ name: 'meetingLink', required: false, type: 'string', format: 'zoomUrl' }]
      }
      expect(() => resolveConversationType({ properties: { meetingLink: 'https://evil.com/j/1' } }, type)).toThrow(
        expect.objectContaining({ statusCode: httpStatus.BAD_REQUEST })
      )
    })

    test('accepts a value that satisfies its declared format', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [{ name: 'meetingLink', required: false, type: 'string', format: 'zoomUrl' }]
      }
      expect(() => resolveConversationType({ properties: { meetingLink: 'https://zoom.us/j/1' } }, type)).not.toThrow()
    })

    test('does not throw for a missing required property when allowDraft is set', () => {
      expect(() => resolveConversationType({ properties: {} }, baseType, true)).not.toThrow()
    })

    test('does not throw for an invalid format when allowDraft is set', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [{ name: 'meetingLink', required: false, type: 'string', format: 'zoomUrl' }]
      }
      expect(() =>
        resolveConversationType({ properties: { meetingLink: 'https://evil.com/j/1' } }, type, true)
      ).not.toThrow()
    })

    test('still throws for an invalid enum even when allowDraft is set', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [
          {
            name: 'model',
            required: false,
            type: 'enum',
            options: [{ llmPlatform: 'openai', llmModel: 'gpt-4' }],
            validationKeys: ['llmPlatform', 'llmModel']
          }
        ]
      }
      expect(() =>
        resolveConversationType({ properties: { model: { llmPlatform: 'openai', llmModel: 'not-a-model' } } }, type, true)
      ).toThrow(expect.objectContaining({ statusCode: httpStatus.BAD_REQUEST }))
    })
  })

  describe('property defaults', () => {
    test('applies simple default for missing optional property', () => {
      const result = resolveConversationType({ properties: { requiredProp: 'val' } }, baseType)
      expect(result.properties.optionalProp).toBe('default-value')
    })

    test('does not overwrite a provided value with a default', () => {
      const result = resolveConversationType({ properties: { requiredProp: 'val', optionalProp: 'custom' } }, baseType)
      expect(result.properties.optionalProp).toBe('custom')
    })

    test('leaves property absent when no default is defined', () => {
      const result = resolveConversationType({ properties: { requiredProp: 'val' } }, baseType)
      expect('noDefault' in result.properties).toBe(false)
    })

    test('builds object default from schema defaultX fields', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [
          {
            name: 'categories',
            required: false,
            type: 'object',
            schema: [
              { name: 'tech', defaultEnabled: true, defaultWeight: 2 },
              { name: 'science', defaultEnabled: false, defaultWeight: 1 }
            ]
          }
        ]
      }
      const result = resolveConversationType({ properties: {} }, type)
      expect(result.properties.categories).toEqual({
        tech: { enabled: true, weight: 2 },
        science: { enabled: false, weight: 1 }
      })
    })
  })

  describe('features', () => {
    const typeWithFeature: ConversationType = {
      ...baseType,
      properties: [],
      features: [
        {
          name: 'myFeature',
          label: 'My Feature',
          category: 'assistant',
          userControlled: false,
          default: true,
          agents: [{ name: 'featureAgent' }],
          properties: [{ name: 'interval', required: false, type: 'number', default: 5 }]
        },
        {
          name: 'simpleFeature',
          label: 'Simple Feature',
          category: 'group-chat',
          userControlled: false,
          default: false,
          agents: [{ name: 'simpleAgent' }]
        }
      ]
    }

    test('feature is stored as disabled when not requested', () => {
      const result = resolveConversationType({ features: [] }, typeWithFeature)
      expect(result.features).toContainEqual({ name: 'myFeature', enabled: false })
    })

    test('enables feature with defaults when requested without config', () => {
      const result = resolveConversationType({ features: [{ name: 'myFeature' }] }, typeWithFeature)
      expect(result.features).toContainEqual({ name: 'myFeature', enabled: true, config: { interval: 5 } })
    })

    test('enables feature and merges provided config over defaults', () => {
      const result = resolveConversationType(
        { features: [{ name: 'myFeature', config: { interval: 10 } }] },
        typeWithFeature
      )
      expect(result.features).toContainEqual({ name: 'myFeature', enabled: true, config: { interval: 10 } })
    })

    test('omits config when feature has no properties and none provided', () => {
      const result = resolveConversationType({ features: [{ name: 'simpleFeature' }] }, typeWithFeature)
      expect(result.features).toContainEqual({ name: 'simpleFeature', enabled: true })
      expect(result.features.find((f) => f.name === 'simpleFeature')).not.toHaveProperty('config')
    })

    test('includes feature agents in agentTypes when feature is enabled', () => {
      const result = resolveConversationType({ features: [{ name: 'myFeature' }] }, typeWithFeature)
      expect(result.agentTypes.some((a) => a.name === 'featureAgent')).toBe(true)
    })

    test('excludes feature agents from agentTypes when feature is disabled', () => {
      const result = resolveConversationType({ features: [] }, typeWithFeature)
      expect(result.agentTypes.some((a) => a.name === 'featureAgent')).toBe(false)
    })
  })

  describe('agent resolution', () => {
    test('includes base agents', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [],
        agents: [{ name: 'baseAgent' }]
      }
      const result = resolveConversationType({}, type)
      expect(result.agentTypes).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'baseAgent' })]))
    })

    test('resolves agent properties via $ref into resolved properties', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [
          { name: 'llmModel', required: false, type: 'object', default: { llmModel: 'gpt-4', llmPlatform: 'openai' } }
        ],
        agents: [
          {
            name: 'myAgent',
            properties: [{ $ref: 'llmModel.llmModel' }, { $ref: 'llmModel.llmPlatform' }]
          }
        ]
      }
      const result = resolveConversationType({ properties: {} }, type)
      const agent = result.agentTypes.find((a) => a.name === 'myAgent')
      expect(agent?.properties).toEqual({ llmModel: 'gpt-4', llmPlatform: 'openai' })
    })

    test('resolves agent properties via $ref with custom as key', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [{ name: 'myProp', required: false, type: 'string', default: 'hello' }],
        agents: [{ name: 'myAgent', properties: [{ $ref: 'myProp', as: 'agentConfig.greeting' }] }]
      }
      const result = resolveConversationType({ properties: {} }, type)
      const agent = result.agentTypes.find((a) => a.name === 'myAgent')
      expect(agent?.properties).toEqual({ agentConfig: { greeting: 'hello' } })
    })

    test('resolves a feature toggle into agentConfig as a boolean (seriesHistory pattern)', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [],
        features: [
          {
            name: 'seriesHistory',
            label: 'Series History',
            default: false,
            category: 'assistant',
            userControlled: false,
            agents: [],
            properties: []
          }
        ],
        agents: [{ name: 'myAgent', properties: [{ $ref: 'seriesHistory', as: 'agentConfig.seriesHistory' }] }]
      }

      // Disabled (default OFF) when not requested
      const offResult = resolveConversationType({ properties: {}, features: [] }, type)
      expect(offResult.agentTypes.find((a) => a.name === 'myAgent')?.properties).toEqual({
        agentConfig: { seriesHistory: false }
      })

      // Enabled when requested
      const onResult = resolveConversationType({ properties: {}, features: [{ name: 'seriesHistory' }] }, type)
      expect(onResult.agentTypes.find((a) => a.name === 'myAgent')?.properties).toEqual({
        agentConfig: { seriesHistory: true }
      })
    })

    test('resolves agent properties via ConfigProperty name/default', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [],
        agents: [
          {
            name: 'myAgent',
            properties: [{ name: 'botName', required: false, type: 'string', default: 'Bot', as: 'agentConfig.botName' }]
          }
        ]
      }
      const result = resolveConversationType({ properties: {} }, type)
      const agent = result.agentTypes.find((a) => a.name === 'myAgent')
      expect(agent?.properties).toEqual({ agentConfig: { botName: 'Bot' } })
    })
  })

  describe('adapter resolution', () => {
    const typeWithAdapters: ConversationType = {
      ...baseType,
      properties: [{ name: 'meetingUrl', required: false, type: 'string', default: 'https://zoom.us/j/123' }],
      adapters: {
        zoom: {
          type: 'zoom',
          config: { meetingUrl: '{{{properties.meetingUrl}}}' },
          audioChannels: [{ name: 'transcript', direction: Direction.INCOMING }]
        },
        default: {
          type: 'web',
          config: { endpoint: 'ws://localhost' }
        }
      }
    }

    test('matches adapter by platform name', () => {
      const result = resolveConversationType({ platforms: ['zoom'], properties: {} }, typeWithAdapters)
      expect(result.adapters).toHaveLength(1)
      expect(result.adapters[0]).toMatchObject({ type: 'zoom' })
    })

    test('falls back to default adapter when no platform matched', () => {
      const result = resolveConversationType({ platforms: ['web'], properties: {} }, typeWithAdapters)
      expect(result.adapters).toHaveLength(1)
      expect(result.adapters[0]).toMatchObject({ type: 'web' })
    })

    test('uses default adapter when no platforms provided', () => {
      const result = resolveConversationType({ properties: {} }, typeWithAdapters)
      expect(result.adapters).toHaveLength(1)
      expect(result.adapters[0]).toMatchObject({ type: 'web' })
    })

    test('resolves handlebars property references in adapter config', () => {
      const result = resolveConversationType(
        { platforms: ['zoom'], properties: { meetingUrl: 'https://zoom.us/j/456' } },
        typeWithAdapters
      )
      expect(result.adapters[0]).toMatchObject({ config: { meetingUrl: 'https://zoom.us/j/456' } })
    })

    test('returns empty adapters when no match and no default', () => {
      const type: ConversationType = { ...baseType, properties: [], adapters: { zoom: { type: 'zoom' } } }
      const result = resolveConversationType({ platforms: ['web'] }, type)
      expect(result.adapters).toHaveLength(0)
    })

    test('matches composite platform key over individual keys', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [],
        adapters: {
          zoom: { type: 'zoom', config: { variant: 'zoom-only' } },
          'nextspace,zoom': { type: 'zoom', config: { variant: 'hybrid' } },
          default: { type: 'web' }
        }
      }
      const result = resolveConversationType({ platforms: ['zoom', 'nextspace'] }, type)
      expect(result.adapters).toHaveLength(1)
      expect(result.adapters[0]).toMatchObject({ config: { variant: 'hybrid' } })
    })

    test('composite key matches regardless of platform order', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [],
        adapters: {
          'nextspace,zoom': { type: 'zoom', config: { variant: 'hybrid' } },
          default: { type: 'web' }
        }
      }
      const result = resolveConversationType({ platforms: ['nextspace', 'zoom'] }, type)
      expect(result.adapters).toHaveLength(1)
      expect(result.adapters[0]).toMatchObject({ config: { variant: 'hybrid' } })
    })

    test('falls back to per-platform adapters when no composite key matches', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [],
        adapters: {
          zoom: { type: 'zoom' },
          'nextspace,zoom': { type: 'zoom', config: { variant: 'hybrid' } }
        }
      }
      // Only zoom platform — matches single 'zoom' key, not composite
      const result = resolveConversationType({ platforms: ['zoom'] }, type)
      expect(result.adapters).toHaveLength(1)
      expect(result.adapters[0]).toMatchObject({ type: 'zoom' })
      expect((result.adapters[0] as { config?: { variant?: string } }).config?.variant).toBeUndefined()
    })
  })

  describe('goals and behaviorPolicy derivation', () => {
    const typeWithGroupChatFeatures: ConversationType = {
      ...baseType,
      properties: [],
      features: [
        {
          name: 'collectiveVoice',
          label: 'Collective Voice',
          category: 'group-chat',
          userControlled: false,
          default: true,
          agents: []
        },
        {
          name: 'catalyst',
          label: 'Catalyst',
          category: 'group-chat',
          userControlled: false,
          default: true,
          agents: []
        }
      ]
    }

    test('includes only DM goals when no features are enabled', () => {
      const result = resolveConversationType({ features: [] }, typeWithGroupChatFeatures)
      expect(result.goals).toEqual([
        'private_reassure',
        'private_not_alone',
        'private_transcript_hook',
        'private_interest_bridge'
      ])
    })

    test('includes facilitative goals when collectiveVoice is enabled', () => {
      const result = resolveConversationType({ features: [{ name: 'collectiveVoice' }] }, typeWithGroupChatFeatures)
      expect(result.goals).toEqual(
        expect.arrayContaining([
          'synthesize_discussion',
          'bridge_topics',
          'invite_quieter_voices',
          'clarify_confusion',
          'surface_signal',
          'structure_conversation'
        ])
      )
      expect(result.goals).not.toContain('provoke_participation')
    })

    test('includes challenge goals when catalyst is enabled', () => {
      const result = resolveConversationType({ features: [{ name: 'catalyst' }] }, typeWithGroupChatFeatures)
      expect(result.goals).toEqual(expect.arrayContaining(['provoke_participation', 'play_commentary', 'poll_reveal']))
      expect(result.goals).not.toContain('synthesize_discussion')
    })

    test('includes all goals when both collectiveVoice and catalyst are enabled', () => {
      const result = resolveConversationType(
        { features: [{ name: 'collectiveVoice' }, { name: 'catalyst' }] },
        typeWithGroupChatFeatures
      )
      expect(result.goals).toEqual(
        expect.arrayContaining(['private_reassure', 'synthesize_discussion', 'provoke_participation'])
      )
    })

    test('sets neutral behaviorPolicy baseline regardless of features', () => {
      const result = resolveConversationType({ features: [] }, typeWithGroupChatFeatures)
      expect(result.behaviorPolicy.globalPolicy).toMatchObject({
        tone: 'warmSupportive',
        verbosity: 'brief',
        formality: 'semiFormal',
        safetyPosture: 'strict'
      })
      expect(result.behaviorPolicy.channels?.dm?.proactivePolicy).toMatchObject({
        initiativeLevel: 'lightlyProactive',
        minContributionMinutes: 10
      })
    })
  })

  describe('passthrough fields', () => {
    test('returns channels from conversation type', () => {
      const type: ConversationType = {
        ...baseType,
        properties: [],
        channels: [{ name: 'main' }, { name: 'moderator' }]
      }
      const result = resolveConversationType({}, type)
      expect(result.channels).toEqual([{ name: 'main' }, { name: 'moderator' }])
    })

    test('returns empty array when no channels defined', () => {
      const type: ConversationType = { ...baseType, properties: [] }
      const result = resolveConversationType({}, type)
      expect(result.channels).toEqual([])
    })

    test('returns enableDMs from conversation type', () => {
      const type: ConversationType = { ...baseType, properties: [], enableDMs: ['agents'] }
      const result = resolveConversationType({}, type)
      expect(result.enableDMs).toEqual(['agents'])
    })
  })
})
