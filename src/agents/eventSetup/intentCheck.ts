/*
 * Decides whether a Slack message in the event setup channel is asking
 * the bot to help create a new event.
 *
 * The setup channel is single-purpose, so the bar is "is the user
 * expressing intent to plan, create, set up, or schedule an event?"
 * rather than the more general "is this directed at the bot?" check used
 * by chatbot and eventHistorian. We avoid posting the handoff link in
 * response to casual chatter ("hey berkie, you alive?") or off-topic
 * conversation in the channel.
 *
 * Short-circuits with a fuzzy bot-name match before calling the LLM. If
 * the user named the bot in the message text, that's treated as setup
 * intent in this channel. The LLM call only fires when no name was
 * mentioned, which keeps cost down for routine traffic.
 *
 * If the LLM call fails for any reason, we err on the side of NOT
 * posting the link. Better to miss a setup request than to post links
 * into the middle of unrelated conversation.
 */

import { z } from 'zod'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { matchBotMention } from '../helpers/intentChecks.js'
import logger from '../../config/logger.js'

const intentSchema = z.object({ intended_for_setup: z.boolean() })

const SYSTEM_PROMPT = `You are evaluating whether a Slack message is asking an event-setup assistant to help create a new event.

Match (intended_for_setup: true) when the user is expressing intent to:
- create, set up, plan, or schedule a new event
- propose an event topic, panel, talk, or discussion
- kick off the process of organizing something new

Do NOT match (intended_for_setup: false) for:
- casual chatter or greetings ("hey", "good morning")
- questions about existing events ("when is Tuesday's panel?")
- generic questions to the bot ("are you online?", "what time is it?")
- statements that mention an event without asking to create one

When in doubt, default to false.

Respond with a single JSON object: {{ "intended_for_setup": true }} or {{ "intended_for_setup": false }}`

export async function checkEventSetupIntent(llm, botName, userMessage): Promise<boolean> {
  const words = userMessage?.body?.trim().split(/\s+/) ?? []
  if (matchBotMention(words, botName)) return true

  try {
    const response = await getChatPromptResponse(
      llm,
      SYSTEM_PROMPT,
      'Message: {question}',
      { question: userMessage?.body },
      [],
      intentSchema
    )
    return response?.intended_for_setup === true
  } catch (err) {
    logger.error(`event-setup intent check failed: ${(err as Error).message}`)
    return false
  }
}

export default { checkEventSetupIntent }
