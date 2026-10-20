import { expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, On } from 'claude-code'

import { classify, parseAgentDefinition, sameFamily } from '../hooks/policy'

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

/** The engine resolves a read's path before hooks see it, with the host's
 * separators; a mock matches on the tail with one spelling. */
function isFile(path: string, tail: string): boolean {
  return path.replace(/\\/g, '/').endsWith(tail)
}

// The bottom of the chain stands for the engine: it records what reached it,
// answers the store from memory, and starts a pretend subagent. What the mod
// rewrote is in `seen.last.model`; what it recorded is in `seen.stored`.
function engine(on: On) {
  const seen: { last?: AgentSpawnInput; stored: unknown[] } = { stored: [] }
  on('agent.spawn', (_$, e) => {
    seen.last = e
    return { model: e.model ?? e.parentModel, agentId: 'agent-1' }
  })
  on('store.get', () => ({ value: seen.stored }))
  on('store.set', (_$, e) => {
    seen.stored = Array.isArray(e.value) ? e.value : []
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

test('research with only read verbs goes to haiku', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input({ ...research, model: 'sonnet' }))
  expect(seen.last?.model).toBe('haiku')
})

test('an implement task goes to opus', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(
    input({
      prompt: 'Implement the quick-order PIN dialog and wire it to the cart service.',
      description: 'Implement PIN dialog',
      subagentType: 'general-purpose',
      model: 'sonnet',
    }),
  )
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
  await $.agent.spawn(
    input({
      prompt: 'Implement nothing; just map the module layout.',
      description: 'Map layout',
      subagentType: 'Explore',
      model: 'sonnet',
    }),
  )
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
  await $.agent.spawn(
    input({
      prompt: 'Fix the layout by reading the files first.',
      description: 'Fix layout',
      subagentType: 'scout',
      model: 'opus',
    }),
  )
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

test('routing off leaves every spawn as proposed', { options: { enabled: false } }, async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input({ ...research, model: 'opus' }))
  expect(seen.last?.model).toBe('opus')
})

test('the configured models are honoured', { options: { trivial_model: 'sonnet', heavy_model: 'fable' } }, async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input({ ...research, model: 'opus' }))
  expect(seen.last?.model).toBe('sonnet')
  await $.agent.spawn(input({ prompt: 'Refactor the cart service.', description: 'Refactor cart', subagentType: 'general-purpose', model: 'sonnet' }))
  expect(seen.last?.model).toBe('fable')
})

test('every decision is recorded in the store', async ($, on) => {
  const seen = engine(on)
  await $.agent.spawn(input({ ...research, model: 'sonnet' }))
  await $.agent.spawn(input({ prompt: 'Do the thing.', description: 'Thing', subagentType: 'general-purpose' }))
  expect(seen.stored).toHaveLength(2)
  expect(seen.stored[0]).toMatchObject({ tier: 'trivial', asked: 'sonnet', picked: 'haiku' })
  expect(seen.stored[1]).toMatchObject({ tier: 'inherit', picked: '' })
})

test('policy: verdicts and reasons', async () => {
  expect(classify({ subagentType: 'general-purpose', description: 'Code review teesheet fix', prompt: '' })).toMatchObject({ tier: 'heavy' })
  expect(classify({ subagentType: 'general-purpose', description: 'Write teesheet test cases', prompt: '' })).toMatchObject({ tier: 'light' })
  expect(classify({ subagentType: 'general-purpose', description: 'Upload workbook to Drive', prompt: '' })).toMatchObject({ tier: 'light' })
  expect(classify({ subagentType: 'general-purpose', description: 'Live-run inventory baseline', prompt: '' })).toMatchObject({ tier: 'heavy', reason: 'browser run' })
  expect(classify({ subagentType: 'general-purpose', description: 'noop', prompt: 'wait' })).toMatchObject({ tier: 'inherit' })
})

test('policy: frontmatter parsing', async () => {
  expect(parseAgentDefinition('no frontmatter')).toEqual({})
  expect(parseAgentDefinition('---\nmodel: opus\n---\n')).toEqual({ model: 'opus' })
  expect(parseAgentDefinition('---\ntools: [Read, "Grep"]\n---\n')).toEqual({ tools: ['Read', 'Grep'] })
  expect(parseAgentDefinition('---\ntools:\n  - Read\n  - WebFetch\nmodel: haiku\n---\n')).toEqual({ tools: ['Read', 'WebFetch'], model: 'haiku' })
  expect(sameFamily('claude-sonnet-5-5', 'sonnet')).toBe(true)
  expect(sameFamily('opus', 'sonnet')).toBe(false)
  expect(sameFamily(undefined, 'sonnet')).toBe(false)
})
