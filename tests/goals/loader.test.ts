import { loadGoal, loadGoals, getGroupChatGoals, getDmGoals } from '../../src/goals/loader.js'

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
