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
    label: 'Past event transcripts and notes',
    description: 'Search previous sessions to see what was discussed, when an event happened, or who spoke on a topic.',
    starterQuestions: [
      'Who spoke about decentralized identity at our last workshop?',
      'When did we host the discussion on algorithmic fairness?'
    ]
  },
  bkc_archive_wiki: {
    label: 'Curated archive',
    description: 'Explore the curated archive of research, people profiles, newsletters, and talk transcripts.',
    starterQuestions: [
      'What has the archive published on youth and media?',
      'Which people in the archive work on public interest technology?'
    ],
    available: () => Boolean(config.bkcArchive.apiUrl)
  },
  web_search: {
    label: 'Live web search with sources',
    description: 'Search the broader web for recent information, complete with cited links.',
    starterQuestions: ['What are the latest regulatory updates on the EU AI Act?']
  }
}

const NOTICE_COPY: Record<string, string> = {
  event_ended: 'When a scheduled event wraps up, I post a quick recap so you can catch the main takeaways.',
  participant_joined: 'When a newcomer joins, I share a brief greeting and orientation to help them get settled.'
}

const PAGE_COPY = {
  headline: 'Meet {botName}, your community assistant',
  intro:
    '{botName} is an AI assistant built to help our community find information, catch up on discussions, and navigate shared resources. It is here for all members, whether you are looking for past talk notes or exploring research topics.',
  featuresHeading: 'What I can help you find',
  noticesHeading: 'Automatic updates',
  reachHeading: 'How to reach me',
  reachChannel: 'To keep the room quiet, I only respond in {channel} when someone mentions @{botName} directly.',
  reachDirectMessage:
    'You can also message me in the Messages tab anytime without tagging my name, and I will reply to every message.',
  footer:
    'I do my best to provide accurate answers, but I can occasionally get facts wrong. Please verify critical information using the cited sources.'
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

  const fill = (copy: string) =>
    copy.replaceAll('{botName}', botName).replaceAll('{channel}', reach.channelId ?? '')

  const reachLines: string[] = []
  if (reach.channelId) reachLines.push(fill(PAGE_COPY.reachChannel))
  if (reach.canDirectMessage) reachLines.push(fill(PAGE_COPY.reachDirectMessage))

  return {
    headline: fill(PAGE_COPY.headline),
    intro: fill(PAGE_COPY.intro),
    featuresHeading: fill(PAGE_COPY.featuresHeading),
    features: buildFeatures(toolNames),
    noticesHeading: fill(PAGE_COPY.noticesHeading),
    notices: buildNotices(notificationKeys).map(fill),
    reachHeading: fill(PAGE_COPY.reachHeading),
    reachLines,
    channelId: reach.channelId,
    questionsAreClickable: Boolean(reach.canDirectMessage),
    footer: fill(PAGE_COPY.footer)
  }
}
