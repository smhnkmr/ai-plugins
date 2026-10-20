import { expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, AgentSpec, On, PromptComposeInput, PromptComposeSection, TurnCompleteInput } from 'claude-code'

import { agentSpecs, reportContract } from '../hooks/agents'
import { parseOrchestratorPolicy } from '../hooks/policy'
import { SECTION_ID, buildSection } from '../hooks/section'

const ENGINE_SECTIONS: readonly PromptComposeSection[] = [
  { id: 'intro', text: 'You are Claude Code.', scope: 'shared' },
  { id: 'cwd', text: 'cwd: C:/repo', scope: 'session' },
]

function isFile(path: string, tail: string): boolean {
  return path.replace(/\\/g, '/').endsWith(tail)
}

// The bottom of the chain stands for the engine: it answers the system prompt
// with two sections, records every agent registration, starts a pretend
// subagent, and keeps the store in memory.
function engine(on: On) {
  const seen: { registered: AgentSpec[]; spawned: AgentSpawnInput[]; stored: unknown[]; started: number } = {
    registered: [],
    spawned: [],
    stored: [],
    started: 0,
  }
  on('prompt.compose', () => ({ sections: ENGINE_SECTIONS }))
  on('agent.register', (_$, e) => {
    seen.registered.push(e)
    return { value: { agent: `orchestrator:${e.name}` } }
  })
  on('agent.spawn', (_$, e) => {
    seen.spawned.push(e)
    seen.started += 1
    return { model: e.model ?? e.parentModel, agentId: `agent-${seen.started}` }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-1' }))
  on('store.get', () => ({ value: seen.stored }))
  on('store.set', (_$, e) => {
    seen.stored = Array.isArray(e.value) ? e.value : []
    return { value: undefined }
  })
  mock.clock(on)
  mock.env(on, {})
  return seen
}

function spawn(subagentType: string): AgentSpawnInput {
  return {
    tool_use_id: 'toolu_test',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    prompt: 'Do the thing.',
    description: 'Thing',
    subagentType,
  }
}

function finished(agentId: string | undefined, answer: string, output = 500): TurnCompleteInput {
  return {
    turnId: 'turn-1',
    ...(agentId ? { agentId } : {}),
    answer,
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
    usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
  }
}

const start = { cwd: 'C:/repo', surface: 'terminal' as const, isInteractive: true }

/** A system-prompt render as the engine would ask for it. */
const render: PromptComposeInput = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: ['Read', 'Edit', 'Bash', 'Agent'],
  outputStyle: null,
  traits: [],
}

// ---------------------------------------------------------------- section

test('the delegation section is appended last, session-scoped, once', async ($, on) => {
  engine(on)
  const { sections } = await $.prompt.compose(render)
  expect(sections).toHaveLength(3)
  expect(sections[2]).toMatchObject({ id: SECTION_ID, scope: 'session' })
  expect(sections[2]?.text).toContain('orchestrator:scout')
  expect(sections[2]?.text).toContain('within 40 lines')
  expect(sections[2]?.text).toContain('Sonnet')
})

test('the section text is identical across renders', async ($, on) => {
  engine(on)
  const first = await $.prompt.compose(render)
  const second = await $.prompt.compose(render)
  expect(second.sections[2]?.text).toBe(first.sections[2]?.text)
})

test('off leaves the system prompt untouched', { options: { enabled: false } }, async ($, on) => {
  engine(on)
  const { sections } = await $.prompt.compose(render)
  expect(sections).toHaveLength(2)
})

test('the section reflects the configured models and cap', { options: { verifier_model: 'opus', report_lines: 60 } }, async ($, on) => {
  engine(on)
  const { sections } = await $.prompt.compose(render)
  expect(sections[2]?.text).toContain('runs suites and browser flows, Opus')
  expect(sections[2]?.text).toContain('within 60 lines')
})

// ---------------------------------------------------------------- agents

test('session start registers four agents with pinned models and tools', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start)
  expect(seen.registered.map(a => a.name)).toEqual(['scout', 'researcher', 'worker', 'verifier'])
  expect(seen.registered.map(a => a.model)).toEqual(['haiku', 'haiku', 'sonnet', 'sonnet'])
  expect(seen.registered[0]?.tools).toEqual(['Read', 'Grep', 'Glob'])
  expect(seen.registered[3]?.tools).toBeUndefined()
  expect(seen.registered[3]?.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit'])
  expect(seen.registered[2]?.prompt).toContain(reportContract(40))
})

test('off registers nothing', { options: { enabled: false } }, async ($, on) => {
  const seen = engine(on)
  await $.session.start(start)
  expect(seen.registered).toHaveLength(0)
})

test('the repo policy overrides a model, tools, the cap and adds facts', async ($, on) => {
  const seen = engine(on)
  on('fs.read', (_$, e) =>
    isFile(e.path, '.claude/orchestrator.json')
      ? { value: JSON.stringify({ agents: { worker: { model: 'opus' }, verifier: { tools: ['Bash'] } }, facts: ['A worker cold start costs about fifteen main-loop steps.'], report_lines: 25 }) }
      : { deny: 'ENOENT' },
  )
  await $.session.start(start)
  expect(seen.registered[2]?.model).toBe('opus')
  expect(seen.registered[3]?.tools).toEqual(['Bash'])
  expect(seen.registered[3]?.disallowedTools).toBeUndefined()
  const { sections } = await $.prompt.compose(render)
  expect(sections[2]?.text).toContain('a bounded change with tests, Opus')
  expect(sections[2]?.text).toContain('within 25 lines')
  expect(sections[2]?.text).toContain('- A worker cold start costs about fifteen main-loop steps.')
})

test('a broken policy file is ignored', async ($, on) => {
  const seen = engine(on)
  on('fs.read', (_$, e) => (isFile(e.path, '.claude/orchestrator.json') ? { value: '{ nope' } : { deny: 'ENOENT' }))
  await $.session.start(start)
  expect(seen.registered[2]?.model).toBe('sonnet')
})

// ---------------------------------------------------------------- counters

test('named and generic spawns and main-loop turns are counted per session', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start)
  await $.agent.spawn(spawn('orchestrator:scout'))
  await $.agent.spawn(spawn('general-purpose'))
  await $.turn.complete(finished('agent-1', 'x'.repeat(900)))
  await $.turn.complete(finished(undefined, 'main answer', 1200))
  await $.turn.complete(finished('agent-2', 'y'.repeat(5000)))
  const row = seen.stored[0] as { named: number; generic: number; mainTurns: number; mainOutput: number; reports: number[] }
  expect(seen.stored).toHaveLength(1)
  expect(row).toMatchObject({ named: 1, generic: 1, mainTurns: 1, mainOutput: 1200 })
  expect(row.reports).toEqual([900])
})

test('a spawn passes through unchanged', async ($, on) => {
  const seen = engine(on)
  await $.session.start(start)
  const result = await $.agent.spawn({ ...spawn('orchestrator:worker'), model: 'sonnet' })
  expect(seen.spawned[0]?.model).toBe('sonnet')
  expect(result.agentId).toBe('agent-1')
})

// ---------------------------------------------------------------- pure

test('pure: specs, section and policy parsing', async () => {
  const specs = agentSpecs({ worker: 'opus', verifier: 'sonnet', reportLines: 30 })
  expect(specs.map(s => s.model)).toEqual(['haiku', 'haiku', 'opus', 'sonnet'])
  expect(specs[1]?.prompt).toContain('at most 30 lines')
  const text = buildSection(specs, 30, ['fact one'])
  expect(text.startsWith('# Delegation')).toBe(true)
  expect(text).toContain('Observed on this machine:\n- fact one')
  expect(parseOrchestratorPolicy('nope')).toBeUndefined()
  expect(parseOrchestratorPolicy('{}')).toBeUndefined()
  expect(parseOrchestratorPolicy('{"agents":{"scout":{"model":"bad model"},"worker":{"tools":[1,"Bash"]}},"facts":["  ok  ", ""],"report_lines":5}')).toEqual({
    agents: { worker: { tools: ['Bash'] } },
    facts: ['ok'],
  })
})
