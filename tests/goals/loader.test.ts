import { loadGoal, loadGoals, getGroupChatGoals, getDmGoals, listGoalIds } from '../../src/goals/loader.js'

describe('loadGoal', () => {
  test('loads a known goal by id', () => {
    const goal = loadGoal('bridge_topics')
    expect(goal.id).toBe('bridge_topics')
    expect(goal.channel).toBe('groupChat')
  })

  test('throws for an unknown goal id', () => {
    expect(() => loadGoal('does_not_exist')).toThrow('Unknown goal: does_not_exist')
  })

  test('loaded goal has required fields', () => {
    const goal = loadGoal('private_reassure')
    expect(goal).toMatchObject({
      id: 'private_reassure',
      channel: 'dm',
      label: expect.any(String),
      description: expect.any(String)
    })
  })

  test('normalizes plain string conditions to participant-scoped objects', () => {
    const goal = loadGoal('bridge_topics')
    expect(goal.triggers.conditions.length).toBeGreaterThan(0)
    for (const c of goal.triggers.conditions) {
      expect(c).toMatchObject({ scope: expect.stringMatching(/^event|participant$/), condition: expect.any(String) })
    }
  })

  test('preserves event-scoped conditions from goal JSON', () => {
    const goal = loadGoal('private_transcript_hook')
    const eventConditions = goal.triggers.conditions.filter((c) => c.scope === 'event')
    expect(eventConditions.length).toBeGreaterThan(0)
    expect(eventConditions[0].condition).toMatch(/dense|fast-moving/)
  })

  test('normalizes mixed string and object conditions', () => {
    const goal = loadGoal('private_transcript_hook')
    const scopes = goal.triggers.conditions.map((c) => c.scope)
    expect(scopes).toContain('event')
    expect(scopes).toContain('participant')
  })

  test('loads missing_perspective with required fields and a high confidence floor', () => {
    const goal = loadGoal('missing_perspective')
    expect(goal).toMatchObject({
      id: 'missing_perspective',
      channel: 'groupChat',
      label: expect.any(String),
      description: expect.any(String)
    })
    expect(goal.triggers.minConfidence).toBeGreaterThanOrEqual(75)
    expect(goal.guardrails.length).toBeGreaterThan(0)
    expect(goal.examples.length).toBeGreaterThan(0)
  })

  test('missing_perspective mixes event/participant-scoped and normalized string conditions', () => {
    const goal = loadGoal('missing_perspective')
    const scopes = goal.triggers.conditions.map((c) => c.scope)
    expect(scopes).toContain('participant')
    expect(goal.triggers.conditions.every((c) => typeof c.condition === 'string')).toBe(true)
  })
})

describe('loadGoals', () => {
  test('returns goals for all requested ids', () => {
    const goals = loadGoals(['bridge_topics', 'private_reassure'])
    expect(goals).toHaveLength(2)
    expect(goals.map((g) => g.id)).toEqual(['bridge_topics', 'private_reassure'])
  })

  test('throws if any id is unknown', () => {
    expect(() => loadGoals(['bridge_topics', 'bad_id'])).toThrow('Unknown goal: bad_id')
  })

  test('returns empty array for empty input', () => {
    expect(loadGoals([])).toEqual([])
  })
})

describe('getGroupChatGoals', () => {
  test('returns only groupChat goals', () => {
    const goals = loadGoals(['bridge_topics', 'private_reassure', 'provoke_participation'])
    const result = getGroupChatGoals(goals)
    expect(result.every((g) => g.channel === 'groupChat')).toBe(true)
    expect(result.map((g) => g.id)).toContain('bridge_topics')
    expect(result.map((g) => g.id)).not.toContain('private_reassure')
  })

  test('returns empty array when no groupChat goals present', () => {
    const goals = loadGoals(['private_reassure', 'private_not_alone'])
    expect(getGroupChatGoals(goals)).toEqual([])
  })
})

describe('socratic_probe', () => {
  test('loads as a groupChat text goal with a confidence floor and examples', () => {
    const goal = loadGoal('socratic_probe')
    expect(goal).toMatchObject({ id: 'socratic_probe', channel: 'groupChat', outputContract: { format: 'text' } })
    expect(goal.triggers.minConfidence).toBe(70)
    expect(goal.triggers.conditions.length).toBeGreaterThan(0)
    expect(goal.guardrails.length).toBeGreaterThan(0)
    expect(goal.examples.length).toBeGreaterThan(0)
  })

  test('every example is a single one-sentence question within the word limit', () => {
    for (const example of loadGoal('socratic_probe').examples) {
      expect(example.match(/\?/g)).toHaveLength(1)
      expect(example.trim().endsWith('?')).toBe(true)
      expect(example.trim().split(/(?<=[.!?])\s+/)).toHaveLength(1)
      expect(example.split(/\s+/).length).toBeLessThan(35)
    }
  })

  test('triggers on a loaded word the readings use differently', () => {
    const conditions = loadGoal('socratic_probe').triggers.conditions.map((c) => c.condition)
    expect(conditions.some((c) => /loaded word/i.test(c) && /without saying what they mean/i.test(c))).toBe(true)
  })

  test('guards against invented analogies and anchors loaded words without attributing them', () => {
    const guardrails = loadGoal('socratic_probe').guardrails.join('\n')
    expect(guardrails).toMatch(/no analogies, hypothetical scenarios, or examples of your own/i)
    expect(guardrails).toMatch(/only if the retrieved passage itself contains it/i)
    expect(guardrails).toMatch(/quote that exact word, never who said it, and still name the source in the same sentence/i)
    expect(guardrails).toMatch(/don't repeat a question or passage already used/i)
  })

  test('includes an example that anchors on a quoted loaded word and names the source', () => {
    const { examples } = loadGoal('socratic_probe')
    expect(examples.some((e) => /'fair'/.test(e) && /Tyler's/.test(e))).toBe(true)
  })
})

describe('listGoalIds', () => {
  test('includes known goal ids from both channels', () => {
    const ids = listGoalIds()
    expect(ids).toContain('bridge_topics')
    expect(ids).toContain('private_reassure')
    expect(ids).toContain('missing_perspective')
    expect(ids).toContain('socratic_probe')
  })

  test('does not include the schema.json file as a goal id', () => {
    expect(listGoalIds()).not.toContain('schema')
  })
})

describe('getDmGoals', () => {
  test('returns only dm goals', () => {
    const goals = loadGoals(['private_reassure', 'bridge_topics', 'private_not_alone'])
    const result = getDmGoals(goals)
    expect(result.every((g) => g.channel === 'dm')).toBe(true)
    expect(result.map((g) => g.id)).toContain('private_reassure')
    expect(result.map((g) => g.id)).not.toContain('bridge_topics')
  })

  test('returns empty array when no dm goals present', () => {
    const goals = loadGoals(['bridge_topics', 'provoke_participation'])
    expect(getDmGoals(goals)).toEqual([])
  })
})
