import fs from 'fs'
import path from 'path'
import { ConversationGoal, TriggerCondition } from '../types/index.types.js'

const GOALS_DIR = path.resolve(process.cwd(), 'goals')

function normalizeConditions(raw: (string | TriggerCondition)[]): TriggerCondition[] {
  return raw.map((c) => (typeof c === 'string' ? { scope: 'participant' as const, condition: c } : c))
}

const goalCache = new Map<string, ConversationGoal>(
  fs
    .readdirSync(GOALS_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'schema.json')
    .map((f) => {
      const id = f.replace('.json', '')
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const raw = JSON.parse(fs.readFileSync(path.join(GOALS_DIR, f), 'utf8'))
      const goal: ConversationGoal = {
        ...raw,
        triggers: { ...raw.triggers, conditions: normalizeConditions(raw.triggers.conditions) }
      }
      return [id, goal]
    })
)

function loadGoal(id: string) {
  const goal = goalCache.get(id)
  if (!goal) throw new Error(`Unknown goal: ${id}`)
  return goal
}

function loadGoals(goalIds: string[]) {
  return goalIds.map(loadGoal)
}

function getGroupChatGoals(goals: ConversationGoal[]) {
  return goals.filter((p) => p.channel === 'groupChat')
}

function getDmGoals(goals: ConversationGoal[]) {
  return goals.filter((p) => p.channel === 'dm')
}

function listGoalIds(): string[] {
  return [...goalCache.keys()]
}

export { loadGoal, loadGoals, getGroupChatGoals, getDmGoals, listGoalIds }
