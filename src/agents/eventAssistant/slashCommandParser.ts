/**
 * Slash command configuration
 */
export interface SlashCommand {
  command: string // The command name (e.g., 'visual', 'mindmap')
  prefix: string // The slash prefix to match (e.g., '/visual ', '/mindmap')
  addToChannels?: string[] // Optional: channels to add when this command is detected
}

/**
 * Parse slash commands from user message and return modified message with JSON body
 * @param userMessage - The original user message
 * @param supportedCommands - Array of slash command configurations
 * @returns Modified message with bodyType: 'json' and body: { command, text } if a command was found
 */
export function parseSlashCommands(userMessage, supportedCommands: SlashCommand[]) {
  const modifiedMessage = { ...userMessage }
  const bodyStr = (userMessage.body || '').trim().toLowerCase()

  // Check each supported command
  for (const cmdConfig of supportedCommands) {
    if (bodyStr.startsWith(cmdConfig.prefix.toLowerCase())) {
      // Set bodyType to json
      modifiedMessage.bodyType = 'json'

      // Extract the text after the command prefix
      const text = userMessage.body.trim().substring(cmdConfig.prefix.length).trim()

      // Set body to JSON structure
      modifiedMessage.body = {
        command: cmdConfig.command,
        text
      }

      // Add to channels if specified
      if (cmdConfig.addToChannels && cmdConfig.addToChannels.length > 0) {
        modifiedMessage.channels = modifiedMessage.channels ?? []
        modifiedMessage.channels.push(...cmdConfig.addToChannels)
      }

      // Return on first match (commands are mutually exclusive)
      return modifiedMessage
    }
  }

  // No command found, return unmodified
  return modifiedMessage
}

/**
 * Extract text from a message body (handles both string and JSON body types)
 * @param userMessage - The user message
 * @returns The text content of the message
 */
export function extractMessageText(userMessage) {
  if (userMessage?.bodyType === 'json' && userMessage?.body?.text) {
    return userMessage.body.text
  }
  return userMessage?.body || ''
}

/**
 * Check if a message has a specific command
 * @param userMessage - The user message
 * @param command - The command name to check for
 * @returns True if the message has the specified command
 */
export function hasCommand(userMessage, command) {
  return userMessage?.bodyType === 'json' && userMessage?.body?.command === command
}
