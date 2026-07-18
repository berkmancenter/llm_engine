import fs from 'fs'
import path from 'path'
import { ConversationGoal } from '../types/index.types.js'

const GOALS_DIR = path.resolve(process.cwd(), 'goals')

const goalCache = new Map<string, ConversationGoal>(
  fs
    .readdirSync(GOALS_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'schema.json')
    .map((f) => {
      const id = f.replace('.json', '')
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const goal = JSON.parse(fs.readFileSync(path.join(GOALS_DIR, f), 'utf8')) as ConversationGoal
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

export { loadGoal, loadGoals, getGroupChatGoals, getDmGoals }
