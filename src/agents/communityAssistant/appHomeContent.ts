import config from '../../config/config.js'
import logger from '../../config/logger.js'
import { AppHomeData, AppHomeFeature } from '../../types/index.types.js'

/* Every user-facing string on the App Home page lives in this file, so a copy revision
   is one edit here and never touches the renderer. `{botName}` is substituted at build
   time, the same way the agent's own system prompt fills it in. */

interface FeatureCopy {
  label: string
  description: string
  starterQuestions: string[]
  /* Some tools are configured but inert: the archive tools resolve to an empty list
     when no archive API address is set (see agents/tools/bkcArchiveWiki.ts). Without
     this the page would advertise a search the assistant can never run. */
  available?: () => boolean
}

const FEATURE_COPY: Record<string, FeatureCopy> = {
  event_history: {
    label: 'Look up past events',
    description: 'I can find what earlier events covered, when they happened, and who spoke on a subject.',
    starterQuestions: ['What events happened recently?', 'What topics have past events covered?']
  },
  bkc_archive_wiki: {
    label: 'Search the archive',
    description: 'I can dig through the archive: pages on topics, people, and organizations, plus articles.',
    starterQuestions: ["Tell me about the center's work on AI safety.", 'Who works on content moderation here?'],
    available: () => Boolean(config.bkcArchive.apiUrl)
  },
  web_search: {
    label: 'Search the web',
    description: 'I can check current sources and tell you where the answer came from.',
    starterQuestions: ['What is the latest news on the EU AI Act?']
  }
}

const NOTICE_COPY: Record<string, string> = {
  event_ended: 'When an event wraps up, I post a summary of what happened.',
  participant_joined: 'When someone new joins, I introduce them to the room.'
}

const PAGE_COPY = {
  headline: "Hi, I'm {botName}",
  intro:
    'I help this community find things and think things through. Ask me about past events, search the archive, or talk through whatever you are working on.',
  featuresHeading: 'What I can do',
  noticesHeading: 'What I post on my own',
  reachHeading: 'How to reach me',
  reachChannel: 'Say my name in {channel} and I will answer. I stay quiet otherwise, so the room stays yours.',
  reachDirectMessage: 'Or send me a direct message in the Messages tab above. No need to use my name there.',
  footer: 'I get things wrong sometimes, so check anything that matters. I read recent messages for context.'
}

interface AppHomeReach {
  channelId?: string
  canDirectMessage?: boolean
}

function buildFeatures(toolNames: string[]): AppHomeFeature[] {
  const features: AppHomeFeature[] = []
  for (const key of toolNames) {
    const copy = FEATURE_COPY[key]
    if (!copy) {
      logger.warn(`App Home: no copy for tool "${key}" — leaving it off the page`)
      continue
    }
    if (copy.available && !copy.available()) {
      logger.info(`App Home: tool "${key}" is enabled but not configured — leaving it off the page`)
      continue
    }
    features.push({ key, label: copy.label, description: copy.description, starterQuestions: copy.starterQuestions })
  }
  return features
}

function buildNotices(notificationKeys: string[]): string[] {
  const notices: string[] = []
  for (const key of notificationKeys) {
    const copy = NOTICE_COPY[key]
    if (!copy) {
      logger.warn(`App Home: no copy for notification "${key}" — leaving it off the page`)
      continue
    }
    notices.push(copy)
  }
  return notices
}

/**
 * Turns one deployment's assistant settings into finished page copy.
 *
 * Anything the deployment has switched off, misspelled, or left unconfigured is dropped
 * here rather than in the renderer, so the page can only ever describe what this
 * assistant actually does.
 *
 * @param agentConfig - the agent's stored `agentConfig`, holding `botName`, `tools`, and `notifications`
 * @param reach - how members can get to this assistant in this deployment
 */
export default function buildAppHomeData(
  agentConfig: Record<string, unknown> | undefined,
  reach: AppHomeReach
): AppHomeData {
  const botName = (agentConfig?.botName as string) || config.conversationBotName
  const toolNames = (agentConfig?.tools as string[]) || []
  const notificationKeys = (agentConfig?.notifications as string[]) || []

  const reachLines: string[] = []
  if (reach.channelId) {
    /* <#C123> is Slack's mrkdwn for a channel link; it renders as the channel's name. */
    reachLines.push(PAGE_COPY.reachChannel.replace('{channel}', `<#${reach.channelId}>`))
  }
  if (reach.canDirectMessage) {
    reachLines.push(PAGE_COPY.reachDirectMessage)
  }

  return {
    headline: PAGE_COPY.headline.replace('{botName}', botName),
    intro: PAGE_COPY.intro.replace('{botName}', botName),
    featuresHeading: PAGE_COPY.featuresHeading,
    features: buildFeatures(toolNames),
    noticesHeading: PAGE_COPY.noticesHeading,
    notices: buildNotices(notificationKeys),
    reachHeading: PAGE_COPY.reachHeading,
    reachLines,
    footer: PAGE_COPY.footer
  }
}
