import { supportedModels } from '../agents/helpers/getModelChat.js'
import adapterTypes from '../adapters/config.js'
import { ConversationType, Direction, TRANSCRIPT_CHANNEL } from '../types/index.types.js'
import config from '../config/config.js'

export const ZOOM_MEETING_URL_PROPERTY = 'zoomMeetingUrl' as const

export const PARTICIPANT_CHANNEL = 'participant' as const
export const MODERATOR_CHANNEL = 'moderator' as const
export const CHAT_CHANNEL = 'chat' as const
export const IMAGE_GEN_CHANNEL = 'image-gen' as const
export const PREGAME_CHANNEL = 'pregame' as const

const eventAssistant: ConversationType = {
  // user-facing
  name: 'eventAssistant',
  label: 'Event Assistant',
  description: 'An assistant to answer questions about an event',
  platforms: adapterTypes,
  properties: [
    {
      name: ZOOM_MEETING_URL_PROPERTY,
      label: 'Zoom Meeting URL',
      description: 'The zoom meeting link for transcription purposes',
      required: true,
      type: 'string',
      format: 'zoomUrl'
    },
    {
      name: 'botName',
      label: 'Bot Name',
      description: 'The display name for the bot',
      required: false,
      type: 'string',
      default: config.conversationBotName
    },
    {
      name: 'llmModel',
      label: 'Model that your agents will use',
      required: false,
      type: 'enum',
      options: supportedModels,
      validationKeys: ['llmModel', 'llmPlatform']
    },
    {
      name: 'feedbackFrequency',
      label: 'Feedback Request Frequency',
      description: 'Request feedback every N eligible messages (0 = disabled)',
      required: false,
      type: 'number',
      default: 3
    }
  ],
  /*
   * Each entry determines 3 things: the Features section in the event creation form,
   * the Quick Guide panel shown during live events, and slash command
   * autocomplete (for entries where slashCommand is set).
   *
   * category is required — omitting it is a compile error.
   *
   * category:     functional area this feature corresponds to, such as "assistant", "group-chat", "transcript", or "resources"
   * slashCommand: command text without the slash. Omit for passive features.
   * prerequisite: optional setup instruction shown alongside the description.
   * agents:       backend agents to start when enabled. Empty for user-triggered features.
   * properties:   sub-properties shown in the event creation form.
   */

  features: [
    {
      name: 'moderatorSupport',
      label: 'Moderator Support',
      description:
        'Enables participants to submit questions to the moderator, surfaces insights from messages, and alerts the moderator when significant themes emerge.',
      default: true,
      category: 'assistant',
      userControlled: false,
      slashCommand: 'mod',
      agents: [
        {
          name: 'backChannelInsights',
          properties: [{ $ref: 'llmModel.llmModel' }, { $ref: 'llmModel.llmPlatform' }]
        },
        {
          name: 'moderatorNotifier',
          properties: [{ $ref: 'llmModel.llmModel' }, { $ref: 'llmModel.llmPlatform' }]
        }
      ]
    },
    {
      name: 'collectiveVoice',
      label: 'Collective Voice',
      description:
        'Contributes to the group chat by surfacing what participants are privately thinking, connecting threads across the conversation, and giving the discussion shape and continuity.',
      default: true,
      category: 'group-chat',
      userControlled: false,
      agents: []
    },
    {
      name: 'catalyst',
      label: 'Catalyst',
      description:
        'Participates in the group chat as an active voice — jumping into silences, responding to speakers, challenging unexamined claims, and adding witty observations to encourage participation.',
      default: true,
      category: 'group-chat',
      userControlled: false,
      agents: []
    },
    {
      name: 'librarian',
      label: 'Reading Recommendations',
      description: 'Periodically recommends relevant reading during the event',
      default: true,
      category: 'assistant',
      userControlled: false,
      properties: [
        {
          name: 'recommendationsPerInterval',
          label: 'Number of Reading Recommendations per Interval',
          required: false,
          type: 'number',
          default: 2
        }
      ],
      agents: [
        {
          name: 'librarian',
          properties: [
            { $ref: 'llmModel.llmModel' },
            { $ref: 'llmModel.llmPlatform' },
            { $ref: 'librarian.recommendationsPerInterval', as: 'agentConfig.recommendationsPerInterval' }
          ]
        }
      ]
    },
    {
      name: 'mindmap',
      label: 'Mind Map',
      description: 'Creates a visual mind map of the key topics discussed in the event.',
      category: 'assistant',
      userControlled: true,
      slashCommand: 'mindmap',
      default: true,
      agents: [],
      properties: []
    },
    {
      name: 'visual',
      label: 'Visual Response',
      description: 'Ask for a visual (image) response to a question.',
      category: 'assistant',
      userControlled: true,
      slashCommand: 'visual',
      default: true,
      agents: [],
      properties: []
    },
    {
      name: 'visualPreference',
      label: 'Visuals',
      description: 'Automatically generates a visual when it would help explain a concept.',
      prerequisite: 'Enable it by turning on "Visuals" in your event settings.',
      category: 'assistant',
      userControlled: true,
      default: true,
      agents: [],
      properties: []
    },
    {
      name: 'jargonFilter',
      label: 'Jargon Filter',
      description: 'Automatically explains jargon and technical terms used by speakers.',
      prerequisite: 'Enable it by turning on "Jargon Clarification" in your event settings.',
      category: 'assistant',
      userControlled: true,
      default: true,
      agents: [],
      properties: []
    },
    {
      name: 'unpacker',
      label: 'Unpacker',
      description: 'Lets participants ask the assistant to explain what the speaker just said in plain language.',
      category: 'assistant',
      userControlled: true,
      default: false,
      agents: [],
      respondingAgent: 'eventAssistant',
      properties: []
    },
    {
      name: 'seriesHistory',
      label: 'Series History',
      description: 'Lets the assistant draw on transcripts from past events in the same series when answering questions.',
      default: false,
      category: 'assistant',
      userControlled: false,
      agents: [],
      properties: []
    },
    {
      name: 'voiceOutput',
      label: 'Voice Responses',
      description:
        'Speaks the assistant\'s answer aloud when someone asks it a question by voice (e.g. "Hey <botName>, ..."). Chat responses always stay text-only, regardless of this setting.',
      default: true,
      category: 'assistant',
      userControlled: false,
      agents: [],
      properties: [
        {
          name: 'voiceDestination',
          label: 'Where the Bot Speaks',
          required: false,
          type: 'enum',
          options: [
            {
              name: 'presentation',
              label: 'NextSpace Presentation View',
              description: 'The bot speaks in NextSpace presentation view. Keeps Zoom camera idle.'
            },
            {
              name: 'zoom',
              label: 'Zoom',
              description:
                'The bot speaks directly in Zoom (e.g. a hybrid or in-person meeting where Zoom itself is projected to the room).'
            }
          ],
          validationKeys: ['name'],
          // Only meaningful once NextSpace is in the mix — a Zoom-only conversation has no
          // other venue to defer to
          showForPlatforms: ['nextspace']
        }
      ]
    },
    {
      name: 'pregame',
      label: 'Pregame Access',
      description:
        'Opens the room before the event starts where early arrivals can chat and answer a private warm-up question.',
      default: false,
      category: 'assistant',
      userControlled: false,
      agents: [],
      properties: [
        {
          name: 'preEventMinutes',
          label: 'Doors Open (minutes before start)',
          description: 'How many minutes before the scheduled start time early access opens.',
          required: false,
          type: 'number',
          default: 15
        },
        {
          name: 'warmUpQuestion',
          label: 'Warm-Up Question Source',
          description: 'Whether the private warm-up question is written by the assistant or supplied by the organizer.',
          required: false,
          type: 'enum',
          options: [
            { value: 'organizer', label: 'Organizer written' },
            { value: 'generated', label: 'AI generated' }
          ],
          default: 'generated'
        },
        {
          name: 'warmUpQuestionText',
          label: 'Warm-Up Question Text',
          description: 'Used only when the warm-up question source is organizer.',
          required: false,
          type: 'string'
        },
        {
          name: 'warmUpQuestionFormat',
          label: 'Warm-Up Question Format',
          description: 'Open-ended text, or a single-choice question with fixed options. Applies to either source.',
          required: false,
          type: 'enum',
          options: [
            { value: 'text', label: 'Open-ended text' },
            { value: 'singleChoice', label: 'Single choice' }
          ],
          default: 'text'
        },
        {
          name: 'warmUpQuestionOptions',
          label: 'Warm-Up Question Options',
          description:
            'The selectable options. Used only when source is organizer and format is singleChoice — an agent-authored singleChoice question generates its own options instead.',
          required: false,
          type: 'array'
        },
        {
          name: 'groupChannelOpener',
          label: 'Post Pregame Recap on Start',
          description:
            'When the event starts, post a short recap of the pregame chat and warm-up answers to the group chat.',
          required: false,
          type: 'boolean',
          default: true
        }
      ]
    }
  ],

  // internal
  agents: [
    {
      name: 'proactiveGroupAgent',
      properties: [{ $ref: 'llmModel.llmModel' }, { $ref: 'llmModel.llmPlatform' }]
    },
    {
      name: 'eventAssistant',
      properties: [
        { $ref: 'llmModel.llmModel' },
        { $ref: 'llmModel.llmPlatform' },
        { $ref: 'botName', as: 'agentConfig.botName' },
        { $ref: 'moderatorSupport', as: 'agentConfig.moderatorSupport' },
        { $ref: 'seriesHistory', as: 'agentConfig.seriesHistory' },
        { $ref: 'pregame.warmUpQuestion', as: 'agentConfig.warmUpQuestion.source' },
        { $ref: 'pregame.warmUpQuestionText', as: 'agentConfig.warmUpQuestion.text' },
        { $ref: 'pregame.warmUpQuestionFormat', as: 'agentConfig.warmUpQuestion.format' },
        { $ref: 'pregame.warmUpQuestionOptions', as: 'agentConfig.warmUpQuestion.options' },
        { $ref: 'pregame.groupChannelOpener', as: 'agentConfig.groupChannelOpener' }
      ]
    },
    {
      name: 'jargonFilterAgent',
      properties: [{ $ref: 'llmModel.llmModel' }, { $ref: 'llmModel.llmPlatform' }]
    },
    {
      name: 'voiceAssistant',
      properties: [
        { $ref: 'llmModel.llmModel' },
        { $ref: 'llmModel.llmPlatform' },
        { $ref: 'botName', as: 'agentConfig.botName' },
        { $ref: 'voiceOutput', as: 'agentConfig.voiceOutput' }
      ]
    }
  ],
  propertyBindings: [{ $ref: 'pregame.preEventMinutes' }],
  enableDMs: ['agents'],
  channels: [
    { name: TRANSCRIPT_CHANNEL },
    { name: PARTICIPANT_CHANNEL },
    { name: MODERATOR_CHANNEL },
    { name: CHAT_CHANNEL },
    { name: IMAGE_GEN_CHANNEL },
    { name: PREGAME_CHANNEL }
  ],
  adapters: {
    // Fully remote: Zoom only — moderator DMs sent via Zoom. botMediaMode is computed from the
    // voiceOutput feature itself here (rather than left to zoom.ts, which has no opinion on it)
    // since Zoom's camera is the sole presence in this combo: it should speak when voiceOutput
    // is on, and otherwise just sit idle rather than being hidden entirely.
    zoom: {
      type: 'zoom',
      config: {
        meetingUrl: '{{{properties.zoomMeetingUrl}}}',
        botName: '{{properties.botName}}',
        botMediaMode: '{{#if properties.voiceOutput}}voice{{else}}silent{{/if}}'
      },
      dmChannels: [
        {
          direct: true,
          agent: 'eventAssistant',
          direction: Direction.BOTH
        },
        {
          name: 'moderator',
          direction: Direction.OUTGOING,
          users: 'moderators'
        }
      ],
      // No pregame entry: a Zoom bot can only ever be deployed once a conversation has already
      // started (see isPreEventWindowOpen), so Zoom chat never needs a preEvent-phase channel —
      // early Zoom attendees just land in the regular chat channel, and pregame chat composed on
      // NextSpace is never forwarded into Zoom's native chat panel.
      chatChannels: [
        {
          name: CHAT_CHANNEL,
          direction: Direction.BOTH
        }
      ],
      audioChannels: [
        {
          name: TRANSCRIPT_CHANNEL,
          direction: Direction.INCOMING
        }
      ]
    },
    // Hybrid: Zoom + NextSpace — moderator DMs handled by NextSpace, not Zoom. botMediaMode
    // defers to voiceOutput's own voiceDestination sub-property: stays 'silent' (NextSpace's
    // presentation view speaks instead) unless the organizer explicitly chose 'zoom' there.
    // If voiceOutput is off entirely, properties.voiceOutput is false and accessing
    // .voiceDestination.name on it is simply undefined — never equal to "zoom", so this still
    // correctly resolves to 'silent' with no separate "is voice even on" check needed.
    'nextspace,zoom': {
      type: 'zoom',
      config: {
        meetingUrl: '{{{properties.zoomMeetingUrl}}}',
        botName: '{{properties.botName}}',
        botMediaMode: "{{#if (eq properties.voiceOutput.voiceDestination.name 'zoom')}}voice{{else}}silent{{/if}}"
      },
      dmChannels: [
        {
          direct: true,
          agent: 'eventAssistant',
          direction: Direction.BOTH
        }
      ],
      // Same reasoning as the zoom-only block above: no pregame entry here either.
      chatChannels: [
        {
          name: CHAT_CHANNEL,
          direction: Direction.BOTH
        }
      ],
      audioChannels: [
        {
          name: 'transcript',
          direction: Direction.INCOMING
        }
      ]
    },
    default: {
      // Catch-all, most commonly hit for NextSpace alone (no 'zoom' in platforms) — NextSpace
      // handles chat/DMs over its own connection, so no dmChannels/chatChannels here; Zoom is
      // still deployed purely for transcription. Zoom's own camera stays idle by default, but
      // same voiceDestination override as the 'nextspace,zoom' hybrid below: an organizer can
      // still choose to have the bot speak directly in Zoom instead.
      type: 'zoom',
      config: {
        meetingUrl: '{{{properties.zoomMeetingUrl}}}',
        botName: '{{properties.botName}}',
        botMediaMode: "{{#if (eq properties.voiceOutput.voiceDestination.name 'zoom')}}voice{{else}}none{{/if}}"
      },
      audioChannels: [
        {
          name: TRANSCRIPT_CHANNEL,
          direction: Direction.INCOMING
        }
      ]
    }
  }
}
export default eventAssistant
