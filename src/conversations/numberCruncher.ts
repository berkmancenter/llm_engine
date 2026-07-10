import { ConversationType, Direction } from '../types/index.types.js'

const numberCruncher: ConversationType = {
  name: 'numberCruncher',
  label: 'Number Cruncher',
  description:
    'An admin bot that checks LLM API budget endpoints on a schedule and posts alerts to a Slack channel when spending exceeds configured thresholds',
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
      default: 'Number Cruncher'
    },
    {
      name: 'budgets',
      label: 'Budget Configurations (JSON)',
      description:
        'Array of budget configs. Each entry: { "label": "AWS Bedrock", "endpoint": "https://...", "apiKey": "...", "thresholdPercent": 80 }. Endpoints must return { "quota": { "limit": "250.0" }, "remaining_limit": "199.40" }.',
      required: true,
      type: 'array'
    },
    {
      name: 'checkInterval',
      label: 'Check Interval (seconds)',
      description: 'How often to check budgets, in seconds. Defaults to 86400 (24 hours).',
      required: false,
      type: 'string',
      default: '86400'
    }
  ],
  // internal
  agents: [
    {
      name: 'numberCruncher',
      properties: [
        { $ref: 'botName', as: 'agentConfig.botName' },
        { $ref: 'budgets', as: 'agentConfig.budgets' },
        { $ref: 'checkInterval', as: 'triggers.periodic.timerPeriod' },
        { name: 'proactive', as: 'triggers.periodic.proactive', type: 'boolean', required: false, default: true }
      ]
    }
  ],
  channels: [{ name: 'numberCruncher' }],
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
          name: 'numberCruncher',
          direction: Direction.BOTH
        }
      ]
    }
  }
}

export default numberCruncher
