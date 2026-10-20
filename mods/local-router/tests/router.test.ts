import { expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, On, TurnCompleteInput } from 'claude-code'

import { family, summarize } from '../hooks/outcomes'
import type { Decision } from '../hooks/outcomes'
import { classify, describesSameTask, isPlaceholder, parseAgentDefinition, parseProjectPolicy, sameFamily } from '../hooks/policy'

type Spawn = Pick<AgentSpawnInput, 'prompt' | 'description' | 'subagentType'> &
  Partial<Pick<AgentSpawnInput, 'model' | 'parentModel'>>

/** A spawn as the engine would stamp it before the hooks see it. */
function input(spawn: Spawn): AgentSpawnInput {
  return {
    tool_use_id: 'toolu_test',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-fable-5-1',
    background: false,
    fork: false,
    ...spawn,
  }
}

/** A subagent's end as the engine would report it. */
function finished(agentId: string, model: string, output = 1200): TurnCompleteInput {
  return {
    turnId: 'turn-1',
    agentId,
    answer: 'done',
    durationMs: 4200,
    isAborted: false,
    reason: 'answer',
    usage: { model, input_tokens: 50, output_tokens: output, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300 },
  }
}

/** The engine resolves a read's path before hooks see it, with the host's
 * separators; a mock matches on the tail with one spelling. */
function isFile(path: string, tail: string): boolean {
  return path.replace(/\\/g, '/').endsWith(tail)
}

// The bottom of the chain stands for the engine: it records what reached it,
// answers the store from memory, numbers each started subagent, and ends a
// turn. What the mod rewrote is in `seen.last.model`; what it recorded is in
// `seen.stored`.
function engine(on: On) {
  const seen: { last?: AgentSpawnInput; stored: Decision[]; started: number } = { stored: [], started: 0 }
  on('agent.spawn', (_$, e) => {
    seen.last = e
    seen.started += 1
    return { model: e.model ?? e.parentModel, agentId: `agent-${seen.started}` }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('store.get', () => ({ value: seen.stored }))
  on('store.set', (_$, e) => {
    seen.stored = Array.isArray(e.value) ? (e.value as Decision[]) : []
    return { value: undefined }
  })
  mock.clock(on)
  mock.env(on, {})
  return seen
}

const research: Spawn = {
  prompt: 'Find every place the teesheet component reads the booking date and list the files.',
  description: 'Research booking date reads',
  subagentType: 'general-purpose',
}

const implement: Spawn = {
  prompt: 'Implement the quick-order PIN dialog and wire it to the cart service.',
  description: 'Implement PIN dialog',
  subagentType: 'general-purpose',
  model: 'sonnet',
}

// ---------------------------------------------------------------- routing

test('research with only read verbs goes to haiku', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input({ ...research, model: 'sonnet' }))
  expect(seen.last?.model).toBe('haiku')
})

test('an implement task goes to opus', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input(implement))
  expect(seen.last?.model).toBe('opus')
})

test('heavy verbs beat trivial ones in the same prompt', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(
    input({
      prompt: 'Research the three date libraries we could use, then implement the chosen one in the booking form.',
      description: 'Research and implement date lib',
      subagentType: 'general-purpose',
    }),
  )
  expect(seen.last?.model).toBe('opus')
})

test('a browser verification run is heavy however it is worded', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(
    input({
      prompt: 'Verify cases TS-040 to TS-060 using the Playwright MCP against the staging site.',
      description: 'Verify teesheet cases',
      subagentType: 'general-purpose',
      model: 'sonnet',
    }),
  )
  expect(seen.last?.model).toBe('opus')
})

test('a validate task goes to sonnet', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(
    input({
      prompt: 'Validate that every report in the list has a matching export test.',
      description: 'Validate report tests',
      subagentType: 'general-purpose',
      model: 'opus',
    }),
  )
  expect(seen.last?.model).toBe('sonnet')
})

test('the Explore agent type is trivial whatever the prompt says', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input({ prompt: 'Implement nothing; just map the module layout.', description: 'Map layout', subagentType: 'Explore', model: 'sonnet' }))
  expect(seen.last?.model).toBe('haiku')
})

test('a model declared in the agent definition is left alone', async ($, on) => {
  const seen = engine(on)
  on('fs.read', (_$, e) =>
    isFile(e.path, '.claude/agents/searcher.md')
      ? { value: '---\nname: searcher\nmodel: sonnet\ntools: Read, Grep\n---\nSearch the repo.\n' }
      : { deny: 'ENOENT' },
  )
  await $.agent.spawn(input({ ...research, subagentType: 'searcher', model: 'opus' }))
  expect(seen.last?.model).toBe('opus')
})

test('a read-only tool allowlist makes the agent trivial', async ($, on) => {
  const seen = engine(on)
  on('fs.read', (_$, e) =>
    isFile(e.path, '.claude/agents/scout.md')
      ? { value: '---\nname: scout\ntools:\n  - Read\n  - Grep\n  - Glob\n---\nScout.\n' }
      : { deny: 'ENOENT' },
  )
  await $.agent.spawn(input({ prompt: 'Fix the layout by reading the files first.', description: 'Fix layout', subagentType: 'scout', model: 'opus' }))
  expect(seen.last?.model).toBe('haiku')
})

test('a prompt with no signal is left alone', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input({ prompt: 'Do the thing.', description: 'Thing', subagentType: 'general-purpose', model: 'sonnet' }))
  expect(seen.last?.model).toBe('sonnet')
})

test('a model already in the right family is kept, id or alias', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input({ ...research, model: 'claude-haiku-5-5' }))
  expect(seen.last?.model).toBe('claude-haiku-5-5')
})

test('an inherited parent already in the right family is kept', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input({ ...research, parentModel: 'claude-haiku-5-5' }))
  expect(seen.last?.model).toBeUndefined()
})

test('a fork is never touched', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn({ ...input({ ...research, model: 'sonnet' }), fork: true })
  expect(seen.last?.model).toBe('sonnet')
})

test('the configured models are honoured', { options: { trivial_model: 'sonnet', heavy_model: 'fable' } }, async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input({ ...research, model: 'opus' }))
  expect(seen.last?.model).toBe('sonnet')
  await $.agent.spawn(input({ prompt: 'Refactor the cart service.', description: 'Refactor cart', subagentType: 'general-purpose', model: 'sonnet' }))
  expect(seen.last?.model).toBe('fable')
})

// ---------------------------------------------------------------- modes

test('off leaves every spawn as proposed and records nothing', { options: { mode: 'off' } }, async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input({ ...research, model: 'opus' }))
  expect(seen.last?.model).toBe('opus')
  expect(seen.stored).toHaveLength(0)
})

test('shadow decides and records but changes nothing', { options: { mode: 'shadow' } }, async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input({ ...research, model: 'opus' }))
  expect(seen.last?.model).toBe('opus')
  expect(seen.stored).toHaveLength(1)
  expect(seen.stored[0]).toMatchObject({ tier: 'trivial', asked: 'opus', picked: 'haiku', applied: false, mode: 'shadow', agentId: 'agent-1' })
})

// ---------------------------------------------------------------- placeholder

test('a placeholder spawn is refused in act mode', async ($, on) => {
  const seen = engine(on)
  const result = await $.agent.spawn(input({ prompt: 'wait', description: 'noop wait', subagentType: 'general-purpose' }))
  expect(result.deny).toContain('placeholder')
  expect(seen.started).toBe(0)
  expect(seen.stored[0]).toMatchObject({ tier: 'deny', reason: 'placeholder spawn', applied: true })
})

test('a placeholder spawn goes through in shadow mode, logged as a deny', { options: { mode: 'shadow' } }, async ($, on) => {
  const seen = engine(on)
  const result = await $.agent.spawn(input({ prompt: 'wait', description: 'placeholder no-op cancel', subagentType: 'general-purpose' }))
  expect(result.deny).toBeUndefined()
  expect(seen.started).toBe(1)
  expect(seen.stored[0]).toMatchObject({ tier: 'deny', applied: false })
})

test('a short real task is not a placeholder', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input({ prompt: 'List the files.', description: 'List files', subagentType: 'general-purpose', model: 'sonnet' }))
  expect(seen.started).toBe(1)
  expect(seen.last?.model).toBe('haiku')
})

// ---------------------------------------------------------------- project policy

test('the project policy file overrides a tier for an agent type and a model for a tier', async ($, on) => {
  const seen = engine(on)
  on('fs.read', (_$, e) =>
    isFile(e.path, '.claude/router.json')
      ? { value: JSON.stringify({ agents: { Explore: 'heavy' }, models: { heavy: 'fable' } }) }
      : { deny: 'ENOENT' },
  )
  await $.agent.spawn(input({ prompt: 'Map the layout.', description: 'Map layout', subagentType: 'Explore', model: 'sonnet' }))
  expect(seen.last?.model).toBe('fable')
  expect(seen.stored[0]).toMatchObject({ reason: 'project policy for Explore' })
})

test('the project policy file can add verbs', async ($, on) => {
  const seen = engine(on)
  on('fs.read', (_$, e) =>
    isFile(e.path, '.claude/router.json') ? { value: JSON.stringify({ verbs: { heavy: ['baseline'] } }) } : { deny: 'ENOENT' },
  )
  await $.agent.spawn(input({ prompt: 'Run the inventory baseline.', description: 'Inventory baseline', subagentType: 'general-purpose', model: 'sonnet' }))
  expect(seen.last?.model).toBe('opus')
})

test('a broken project policy file is ignored', async ($, on) => {
  const seen = engine(on)
  on('fs.read', (_$, e) => (isFile(e.path, '.claude/router.json') ? { value: '{ not json' } : { deny: 'ENOENT' }))
  await $.agent.spawn(input({ ...research, model: 'sonnet' }))
  expect(seen.last?.model).toBe('haiku')
})

// ---------------------------------------------------------------- outcomes

test('a finished subagent has its cost attached to its decision', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input({ ...research, model: 'sonnet' }))
  expect(seen.stored[0]?.agentId).toBe('agent-1')
  expect(seen.stored[0]?.outcome).toBeUndefined()
  await $.turn.complete(finished('agent-1', 'claude-haiku-5-5'))
  expect(seen.stored[0]?.outcome).toMatchObject({ model: 'claude-haiku-5-5', reason: 'answer', output: 1200, cacheRead: 9000, turns: 1, toolCalls: 0 })
})

test('a resumed subagent accumulates across its turns', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input(implement))
  await $.turn.complete(finished('agent-1', 'claude-opus-5-5', 1000))
  await $.turn.complete(finished('agent-1', 'claude-opus-5-5', 500))
  expect(seen.stored[0]?.outcome).toMatchObject({ output: 1500, turns: 2 })
})

test('a pending decision in the store still gets its outcome after the counters are lost', async ($, on) => {
  // As after a hot reload: the store has the row, module memory has nothing.
  const seen = engine(on)
  seen.stored = [
    { at: 1, agent: 'general-purpose', description: 'Earlier research', tier: 'trivial', reason: 'verb "research"', asked: 'sonnet', picked: 'haiku', toolUseId: 't', mode: 'act', applied: true, respawn: false, agentId: 'agent-7' },
  ]
  await $.turn.complete(finished('agent-7', 'claude-haiku-5-5', 640))
  expect(seen.stored[0]?.outcome).toMatchObject({ model: 'claude-haiku-5-5', output: 640, toolCalls: 0, turns: 1 })
})

test('a turn of an agent the router never saw is ignored', async ($, on) => {
  const seen = engine(on)
  await $.turn.complete(finished('agent-9', 'claude-opus-5-5'))
  expect(seen.stored).toHaveLength(0)
})

test('spawning the same task again is flagged as a respawn', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input({ ...implement, description: 'Live-run management baseline' }))
  await $.agent.spawn(input({ ...implement, description: 'Resume management live baseline' }))
  expect(seen.stored[0]?.respawn).toBe(false)
  expect(seen.stored[1]?.respawn).toBe(true)
})

// ---------------------------------------------------------------- pure policy

test('policy: verdicts and reasons', async () => {
  expect(classify({ subagentType: 'general-purpose', description: 'Code review teesheet fix', prompt: '' })).toMatchObject({ tier: 'heavy' })
  expect(classify({ subagentType: 'general-purpose', description: 'Write teesheet test cases', prompt: '' })).toMatchObject({ tier: 'light' })
  expect(classify({ subagentType: 'general-purpose', description: 'Upload workbook to Drive', prompt: '' })).toMatchObject({ tier: 'light' })
  expect(classify({ subagentType: 'general-purpose', description: 'Live-run inventory baseline', prompt: '' })).toMatchObject({ tier: 'heavy', reason: 'browser run' })
  expect(classify({ subagentType: 'general-purpose', description: 'noop', prompt: 'wait' })).toMatchObject({ tier: 'inherit' })
  expect(isPlaceholder({ description: 'noop wait', prompt: 'wait' })).toBe(true)
  expect(isPlaceholder({ description: 'Wait for the build then summarize the log', prompt: 'x'.repeat(80) })).toBe(false)
})

test('policy: frontmatter and project policy parsing', async () => {
  expect(parseAgentDefinition('no frontmatter')).toEqual({})
  expect(parseAgentDefinition('---\nmodel: opus\n---\n')).toEqual({ model: 'opus' })
  expect(parseAgentDefinition('---\ntools: [Read, "Grep"]\n---\n')).toEqual({ tools: ['Read', 'Grep'] })
  expect(parseAgentDefinition('---\ntools:\n  - Read\n  - WebFetch\nmodel: haiku\n---\n')).toEqual({ tools: ['Read', 'WebFetch'], model: 'haiku' })
  expect(parseProjectPolicy('nope')).toBeUndefined()
  expect(parseProjectPolicy('{}')).toBeUndefined()
  expect(parseProjectPolicy('{"agents":{"x":"huge"},"models":{"heavy":"bad model"},"verbs":{"light":["", "lint"]}}')).toEqual({ verbs: { light: ['lint'] } })
  expect(sameFamily('claude-sonnet-5-5', 'sonnet')).toBe(true)
  expect(sameFamily('opus', 'sonnet')).toBe(false)
  expect(sameFamily(undefined, 'sonnet')).toBe(false)
})

test('policy: same-task detection and outcome summaries', async () => {
  expect(describesSameTask('Live-run reports baseline', 'Resume reports live baseline')).toBe(true)
  expect(describesSameTask('Verify IN-013 fix on v21', 'Re-verify IN-013 fix')).toBe(true)
  expect(describesSameTask('Write teesheet test cases', 'Write inventory test cases')).toBe(false)
  expect(family('claude-sonnet-5-5')).toBe('sonnet')
  const rows: Decision[] = [
    { at: 1, agent: 'g', description: 'a', tier: 'heavy', reason: 'r', asked: '', picked: 'opus', toolUseId: 't', mode: 'act', applied: true, respawn: false, outcome: { model: 'claude-opus-5-5', reason: 'answer', durationMs: 1, input: 1, cacheRead: 1, cacheWrite: 1, output: 100, toolCalls: 10, toolErrors: 2, turns: 1 } },
    { at: 2, agent: 'g', description: 'b', tier: 'heavy', reason: 'r', asked: '', picked: 'opus', toolUseId: 't', mode: 'act', applied: true, respawn: true, outcome: { model: 'claude-opus-5-5', reason: 'answer', durationMs: 1, input: 1, cacheRead: 1, cacheWrite: 1, output: 300, toolCalls: 30, toolErrors: 0, turns: 1 } },
    { at: 3, agent: 'g', description: 'c', tier: 'heavy', reason: 'r', asked: '', picked: 'opus', toolUseId: 't', mode: 'act', applied: true, respawn: false },
  ]
  expect(summarize(rows)).toEqual([{ tier: 'heavy', model: 'opus', n: 2, medianToolCalls: 30, errorRate: 1, medianOutput: 300, respawnRate: 0.5 }])
})
