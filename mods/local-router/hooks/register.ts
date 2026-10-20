// local-router: picks a subagent's model by task complexity, on this machine.
//
// One decision point, `agent.spawn`. The hook reads what the spawn carries,
// what the agent definition declares and what the project policy overrides,
// classifies the task with policy.ts, and rewrites `model` through `next`. A
// spawn the policy agrees with, or has nothing to say about, goes through
// untouched and silent. In shadow mode every decision is made and recorded
// and none is applied. Every failure path ends in `next(e)`: the spawn runs
// as Claude proposed.
//
// Two more hooks close the loop: `tool.call` counts a routed subagent's tool
// calls and errors while it runs, and `turn.complete` attaches what it cost.
//
// Nothing leaves the machine. `claude plugin validate` lists every call this
// module makes; there is no http.fetch among them.

import type { AgentSpawnInput, AgentSpawnResult, EngineInterface, Next, Register } from 'claude-code'

import { attachOutcome, formatRecent, formatStats, listDecisions, saveDecision } from './outcomes'
import type { Decision, Mode, Outcome } from './outcomes'
import { PLACEHOLDER_DENY, classify, describesSameTask, isPlaceholder, sameFamily } from './policy'
import type { RoutedTier } from './policy'
import { now, readDefinition, readProjectPolicy } from './signals'

type Models = Record<RoutedTier, string>

/** Tool calls and errors counted while a routed subagent runs, by agent id. */
type Counters = { toolCalls: number; toolErrors: number; turns: number; usage: Omit<Outcome, 'model' | 'reason' | 'durationMs' | 'toolCalls' | 'toolErrors' | 'turns'> }

const DECISIONS_SHOWN = 10
const RECENT_FOR_RESPAWN = 12
const RESPAWN_WINDOW_MS = 15 * 60 * 1000

export const register: Register = (on, options) => {
  const mode = pickMode(options.mode)
  const toasts = options.show_toasts !== false
  const defaults: Models = {
    heavy: pick(options.heavy_model, 'opus'),
    light: pick(options.light_model, 'sonnet'),
    trivial: pick(options.trivial_model, 'haiku'),
  }

  // Subagents this session routed and is still accounting for.
  const running = new Map<string, Counters>()

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'router',
        description: 'Local model router: status, recent decisions, stats; on, off or shadow',
        argumentHint: '[stats|on|off|shadow]',
      })
    } catch {
      /* the command is a convenience; routing works without it */
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    if (mode === 'off' || e.fork || e.subagentType === 'fork') return next(e)

    const at = await now($)
    const asked = e.model ?? ''
    const recent = await listDecisions($)
    const respawn = recent
      .slice(-RECENT_FOR_RESPAWN)
      .some(d => at - d.at < RESPAWN_WINDOW_MS && d.agent === e.subagentType && describesSameTask(d.description, e.description))
    const base = { at, agent: e.subagentType, description: e.description, asked, toolUseId: e.tool_use_id, mode, respawn }

    // A placeholder is refused outright in act mode; in shadow it is logged and
    // then classified like any other spawn, so the log shows both verdicts.
    if (isPlaceholder(e)) {
      if (mode === 'act') {
        await saveDecision($, { ...base, tier: 'deny', reason: 'placeholder spawn', picked: '', applied: true })
        if (toasts) $.ui.toast(`router · denied placeholder spawn · ${e.description}`)
        return { deny: PLACEHOLDER_DENY }
      }
      await saveDecision($, { ...base, tier: 'deny', reason: 'placeholder spawn', picked: '', applied: false })
    }

    const policy = await readProjectPolicy($)
    const definition = await readDefinition($, e.subagentType)
    if (definition?.model) {
      return settle($, next, e, { ...base, tier: 'inherit', reason: 'declared in frontmatter', picked: asked, applied: false }, running)
    }

    const { tier, reason } = classify({ subagentType: e.subagentType, description: e.description, prompt: e.prompt, definition, policy })
    if (tier === 'inherit') {
      return settle($, next, e, { ...base, tier, reason, picked: asked, applied: false }, running)
    }

    // What the child would run on without us: the alias Claude asked for, or
    // the parent's model when it asked nothing. Already the right family means
    // nothing to change and nothing to say.
    const picked = policy?.models?.[tier] ?? defaults[tier]
    if (sameFamily(e.model ?? e.parentModel, picked)) {
      return settle($, next, e, { ...base, tier, reason, picked: asked, applied: false }, running)
    }

    const line = `router${mode === 'shadow' ? ' (shadow)' : ''} · ${tier} → ${picked}${asked ? ` (asked ${asked})` : ''} · ${reason} · ${e.description}`
    if (toasts) $.ui.toast(line)
    $.ui.log(line, { to: 'debug' })
    if (mode === 'shadow') {
      return settle($, next, e, { ...base, tier, reason, picked, applied: false }, running)
    }
    return settle($, next, { ...e, model: picked }, { ...base, tier, reason, picked, applied: true }, running)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const counters = e.agentId ? running.get(e.agentId) : undefined
    if (!counters) return next(e)
    counters.toolCalls += 1
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) counters.toolErrors += 1
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // The counters live in module memory, which a hot reload empties. The
    // store still knows which agents this router started and has not heard
    // from, so a subagent that outlives a reload keeps its outcome, minus
    // the tool counts the reload lost.
    let counters = e.agentId ? running.get(e.agentId) : undefined
    if (!counters && e.agentId && (await isPending($, e.agentId))) {
      counters = freshCounters()
      running.set(e.agentId, counters)
    }
    if (counters && e.agentId) {
      counters.turns += 1
      if (e.usage) {
        counters.usage.input += e.usage.input_tokens
        counters.usage.cacheRead += e.usage.cache_read_input_tokens
        counters.usage.cacheWrite += e.usage.cache_creation_input_tokens
        counters.usage.output += e.usage.output_tokens
      }
      await attachOutcome($, e.agentId, {
        model: e.usage?.model ?? '',
        reason: e.reason,
        durationMs: e.durationMs,
        ...counters.usage,
        toolCalls: counters.toolCalls,
        toolErrors: counters.toolErrors,
        turns: counters.turns,
      })
    }
    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off' || arg === 'shadow') {
      const value = arg === 'on' ? 'act' : arg
      try {
        const result = await $.config.set({ key: `${$.plugin.name}.mode`, value })
        if (result.deny !== undefined) return { text: `router: could not switch to ${value}: ${result.deny}. Use /config instead.` }
        return { text: `router ${value}` }
      } catch (error) {
        return { text: `router: could not switch to ${value}: ${String(error)}. Use /config instead.` }
      }
    }

    const rows = await listDecisions($)
    const head = `router ${mode} · heavy → ${defaults.heavy} · light → ${defaults.light} · trivial → ${defaults.trivial} · ${rows.length} decisions kept`
    if (arg === 'stats') return { text: [head, ...formatStats(rows)].join('\n') }
    if (rows.length === 0) return { text: `${head}\nno decisions yet on this machine` }
    return { text: [head, ...formatRecent(rows, DECISIONS_SHOWN)].join('\n') }
  })
}

/** Lets the spawn go on, records the decision with the started agent's id,
 * and starts counting for it when the record is worth an outcome. */
async function settle(
  $: EngineInterface,
  next: Next<'agent.spawn'>,
  input: AgentSpawnInput,
  decision: Omit<Decision, 'agentId'>,
  running: Map<string, Counters>,
): Promise<AgentSpawnResult> {
  const started = await next(input)
  if (started.deny === undefined) {
    const agentId = started.agentId
    await saveDecision($, agentId ? { ...decision, agentId } : decision)
    if (agentId) running.set(agentId, freshCounters())
  }
  return started
}

function freshCounters(): Counters {
  return { toolCalls: 0, toolErrors: 0, turns: 0, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }
}

/** True when the store holds a decision for `agentId` with no outcome yet. */
async function isPending($: EngineInterface, agentId: string): Promise<boolean> {
  const rows = await listDecisions($)
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row && row.agentId === agentId) return row.outcome === undefined
  }
  return false
}

function pick(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function pickMode(value: unknown): Mode {
  return value === 'shadow' || value === 'off' ? value : 'act'
}
