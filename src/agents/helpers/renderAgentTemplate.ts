import handlebars from 'handlebars'

/**
 * Renders a Handlebars template string using agent data as context.
 *
 * This allows `introMessage`, `chatIntroMessage`, and similar agentConfig string
 * properties to include template variables that are resolved at runtime from the
 * agent's own data (e.g. `{{conversation.name}}`, `{{name}}`).
 *
 * Plain strings with no template variables are returned unchanged, so existing
 * configs that use simple strings continue to work without modification.
 *
 * @param template - A string optionally containing Handlebars template variables.
 * @param agent    - The agent instance whose properties are used as the template context.
 * @returns        The rendered string.
 *
 * @example
 * // In an agentConfig:
 * introMessage: "Hey! I'm the {{conversation.name}} Event Assistant."
 *
 * // Rendered with agent data:
 * renderAgentTemplate(agent.agentConfig.introMessage, agent)
 * // => "Hey! I'm the My Cool Event Event Assistant."
 */
export default function renderAgentTemplate(template: string, agent: Record<string, unknown>): string {
  const compiled = handlebars.compile(template, { noEscape: true })
  return compiled(agent)
}
