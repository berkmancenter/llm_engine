import { ConversationType, Direction } from '../types/index.types.js'

const scorekeeper: ConversationType = {
  name: 'scorekeeper',
  label: 'Scorekeeper',
  description:
    'An admin bot that fetches nightly LangSmith evaluator feedback scores for all conversations and posts a quality report card per conversation to a Slack channel',
  platforms: [{ name: 'slack', label: 'Slack' }],
  properties: [
    {
      name: 'slackChannel',
      label: 'Slack Channel ID',
      description: 'The ID of the Slack channel the bot posts to (starts with C- or G-)',
      required: true,
      type: 'string'
    },
    {
      name: 'slackWorkspace',
      label: 'Slack Workspace ID',
      description: 'The Slack workspace (team) ID (starts with T-)',
      required: true,
      type: 'string'
    },
    {
      name: 'slackBotToken',
      label: 'Slack Bot Token',
      description: 'The Bot User OAuth token for the Slack app (starts with xoxb-)',
      required: true,
      type: 'string'
    },
    {
      name: 'slackBotUserId',
      label: 'Slack Bot User ID',
      description: 'The user ID for the bot in Slack (starts with U-), used for routing incoming messages',
      required: false,
      type: 'string'
    },
    {
      name: 'slackSigningSecret',
      label: 'Slack App Signing Secret',
      description: 'The signing secret for the Slack app. Defaults to the system-wide signing secret if not provided.',
      required: false,
      type: 'string'
    },
    {
      name: 'slackAppKey',
      label: 'Slack App Key in Webhook',
      description: 'The app key for the Slack app, used as the last part of the webhook URL to route incoming messages.',
      required: false,
      type: 'string'
    },
    {
      name: 'botName',
      label: 'Bot Name',
      description: 'The name the bot uses when posting messages.',
      required: false,
      type: 'string',
      default: 'Scorekeeper'
    }
  ],
  // internal
  agents: [
    {
      name: 'scorekeeper',
      properties: [{ $ref: 'botName', as: 'agentConfig.botName' }]
    }
  ],
  channels: [{ name: 'scorekeeper' }],
  adapters: {
    slack: {
      type: 'slack',
      config: {
        channel: '{{{properties.slackChannel}}}',
        workspace: '{{{properties.slackWorkspace}}}',
        botToken: '{{{properties.slackBotToken}}}',
        botUserId: '{{{properties.slackBotUserId}}}',
        signingSecret: '{{{properties.slackSigningSecret}}}',
        appKey: '{{{properties.slackAppKey}}}'
      },
      chatChannels: [
        {
          name: 'scorekeeper',
          direction: Direction.BOTH
        }
      ]
    }
  }
}

export default scorekeeper
