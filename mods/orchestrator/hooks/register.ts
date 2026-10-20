// orchestrator: the main model stays whatever the user set and acts as the
// orchestrator. This mod gives it what it cannot see on its own: four named
// cheap agents to delegate to, and the economics of delegation, as a section
// of the system prompt. A switch in userConfig; nothing is ever said in a
// prompt.
//
// Two hooks change what the model sees: session.start registers the agents,
// prompt.compose appends the section. Two only observe: agent.spawn counts
// named against generic spawns, turn.complete measures report length and
// main-loop output. Every failure path leaves the session as it was.

import type { EngineInterface, PromptComposeSection, Register } from 'claude-code'

import { agentSpecs } from './agents'
import type { AgentSettings } from './agents'
import { parseOrchestratorPolicy } from './policy'
import type { OrchestratorPolicy } from './policy'
import { SECTION_ID, buildSection } from './section'

export const POLICY_FILE = '.claude/orchestrator.json'
const SESSIONS_KEY = 'sessions'
const SESSIONS_KEPT = 100

/** What one session did, kept in the store so sessions can be compared. */
type SessionRecord = {
  id: string
  startedAt: number
  named: number
  generic: number
  mainTurns: number
  mainOutput: number
  reports: number[]
}

/** The module's state for one load: the frozen section, the policy read
 * once, the agents registered, and this session's counters. */
type State = {
  settings: AgentSettings
  section?: PromptComposeSection
  policy?: OrchestratorPolicy
  isPolicyRead: boolean
  registered: string[]
  namedAgents: Set<string>
  record: SessionRecord
}

export const register: Register = (on, options) => {
  const enabled = options.enabled !== false
  const state: State = {
    settings: {
      worker: pick(options.worker_model, 'sonnet'),
      verifier: pick(options.verifier_model, 'sonnet'),
      reportLines: count(options.report_lines, 40),
    },
    isPolicyRead: false,
    registered: [],
    namedAgents: new Set(),
    record: { id: '', startedAt: 0, named: 0, generic: 0, mainTurns: 0, mainOutput: 0, reports: [] },
  }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'orchestrate',
        description: "Orchestrator: the named agents, this session's delegation counts; on or off",
        argumentHint: '[on|off]',
      })
    } catch {
      /* the command is a convenience */
    }
    if (!enabled) return next(e)
    await startSession($, state)
    $.ui.status('orchestrator')
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!enabled) return result
    const ours = await sectionFor($, state)
    if (result.sections.some(s => s.id === ours.id)) return result
    return { sections: [...result.sections, ours] }
  })

  on('agent.spawn', async ($, e, next) => {
    if (!enabled) return next(e)
    const isNamed = e.subagentType.startsWith(`${$.plugin.name}:`)
    const started = await next(e)
    if (started.deny === undefined) {
      if (isNamed) state.record.named += 1
      else state.record.generic += 1
      if (isNamed && started.agentId) state.namedAgents.add(started.agentId)
      await save($, state.record)
    }
    return started
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (!enabled) return next(e)
    if (e.agentId === undefined) {
      state.record.mainTurns += 1
      state.record.mainOutput += e.usage?.output_tokens ?? 0
      await save($, state.record)
    } else if (state.namedAgents.has(e.agentId)) {
      state.record.reports.push(e.answer.length)
      await save($, state.record)
    }
    return next(e)
  })

  on('command.run', { command: 'orchestrate' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      try {
        const result = await $.config.set({ key: `${$.plugin.name}.enabled`, value: arg === 'on' })
        if (result.deny !== undefined) return { text: `orchestrator: could not switch ${arg}: ${result.deny}. Use /config instead.` }
        return { text: `orchestrator ${arg}. The system prompt changes from the next turn; mid-session that costs one prefix cache rewrite.` }
      } catch (error) {
        return { text: `orchestrator: could not switch ${arg}: ${String(error)}. Use /config instead.` }
      }
    }
    if (!enabled) return { text: 'orchestrator off' }
    return { text: status($, state) }
  })
}

/** Reads the repo policy once per load; a missing or broken file is none. */
async function loadPolicy($: EngineInterface, state: State): Promise<OrchestratorPolicy | undefined> {
  if (state.isPolicyRead) return state.policy
  state.isPolicyRead = true
  try {
    state.policy = parseOrchestratorPolicy(await $.fs.read(POLICY_FILE))
  } catch {
    state.policy = undefined
  }
  return state.policy
}

/** The section, built on first use and frozen: the same text on every render
 * of the session keeps the prefix cache intact. */
async function sectionFor($: EngineInterface, state: State): Promise<PromptComposeSection> {
  if (state.section) return state.section
  const policy = await loadPolicy($, state)
  const specs = agentSpecs(state.settings, policy)
  state.section = {
    id: SECTION_ID,
    text: buildSection(specs, policy?.report_lines ?? state.settings.reportLines, policy?.facts),
    scope: 'session',
  }
  return state.section
}

/** Registers the four agents and opens this session's record. */
async function startSession($: EngineInterface, state: State): Promise<void> {
  try {
    state.record.id = await $.session.id()
    state.record.startedAt = await $.clock.now()
  } catch {
    /* a session with no id is still orchestrated, just not recorded */
  }
  const policy = await loadPolicy($, state)
  for (const spec of agentSpecs(state.settings, policy)) {
    try {
      const { agent } = await $.agent.register(spec)
      state.registered.push(agent)
    } catch (error) {
      $.ui.log(`orchestrator: could not register ${spec.name}: ${String(error)}`, { to: 'debug' })
    }
  }
}

function status(_$: EngineInterface, state: State): string {
  const specs = agentSpecs(state.settings, state.policy)
  const cap = state.policy?.report_lines ?? state.settings.reportLines
  const record = state.record
  return [
    `orchestrator on · report cap ${cap} lines${state.policy ? ' · repo policy applied' : ''}`,
    ...specs.map(
      spec =>
        `  ${spec.name.padEnd(11)} ${spec.model.padEnd(8)} ${state.registered.some(name => name.endsWith(`:${spec.name}`)) ? 'registered' : 'not registered'}`,
    ),
    `  this session: ${record.named} named spawns, ${record.generic} generic, ${record.mainTurns} main-loop turns, ${record.mainOutput.toLocaleString()} main-loop output tokens, median report ${median(record.reports)} chars`,
  ].join('\n')
}

async function save($: EngineInterface, record: SessionRecord): Promise<void> {
  if (!record.id) return
  try {
    const held = await $.store.get(SESSIONS_KEY)
    const list = (Array.isArray(held) ? (held as SessionRecord[]) : []).filter(row => row.id !== record.id)
    await $.store.set(SESSIONS_KEY, [...list, record].slice(-SESSIONS_KEPT))
  } catch {
    /* a record that cannot be written is one fewer data point */
  }
}

function pick(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 10 && value <= 200 ? Math.round(value) : fallback
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
