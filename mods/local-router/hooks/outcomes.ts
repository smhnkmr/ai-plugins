// The decision log and what is learned from it. One row per spawn the router
// saw, joined to what the subagent then cost. Kept in the plugin's store, the
// last 200, so it survives sessions and never grows past a few hundred KB.

import type { EngineInterface } from 'claude-code'

import type { Tier } from './policy'

export type Mode = 'act' | 'shadow' | 'off'

export type Outcome = {
  /** The model that answered, by the id the API reports. */
  model: string
  /** Why the run ended: answer, aborted, refusal, error. */
  reason: string
  durationMs: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  toolCalls: number
  toolErrors: number
  /** Runs of the subagent's loop; more than one when it was resumed. */
  turns: number
}

export type Decision = {
  at: number
  agent: string
  description: string
  tier: Tier | 'deny'
  reason: string
  /** The alias Claude asked for; empty when it asked nothing. */
  asked: string
  /** What the policy chose; equals `asked` when nothing changed. */
  picked: string
  toolUseId: string
  mode: Mode
  /** True when the spawn actually ran with `picked`; false in shadow and when
   * nothing changed. */
  applied: boolean
  /** True when a recent decision described the same task: a likely retry. */
  respawn: boolean
  agentId?: string
  outcome?: Outcome
}

export const DECISIONS_KEY = 'decisions'
export const DECISIONS_KEPT = 200

export async function listDecisions($: EngineInterface): Promise<Decision[]> {
  try {
    const held = await $.store.get(DECISIONS_KEY)
    return Array.isArray(held) ? (held as Decision[]) : []
  } catch {
    return []
  }
}

export async function saveDecision($: EngineInterface, decision: Decision): Promise<void> {
  try {
    const list = await listDecisions($)
    await $.store.set(DECISIONS_KEY, [...list, decision].slice(-DECISIONS_KEPT))
  } catch {
    /* the decision stands; only its record is lost */
  }
}

/** Attaches an outcome to the newest decision for `agentId`. */
export async function attachOutcome($: EngineInterface, agentId: string, outcome: Outcome): Promise<void> {
  try {
    const list = await listDecisions($)
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const row = list[i]
      if (row && row.agentId === agentId) {
        list[i] = { ...row, outcome }
        await $.store.set(DECISIONS_KEY, list)
        return
      }
    }
  } catch {
    /* an outcome that cannot be written is one fewer data point */
  }
}

export type Summary = {
  tier: string
  model: string
  n: number
  medianToolCalls: number
  errorRate: number
  medianOutput: number
  respawnRate: number
}

/** Per tier and model that answered: how many, how long they ran, how often
 * tools errored, how often the task was spawned again. */
export function summarize(rows: readonly Decision[]): Summary[] {
  const groups = new Map<string, Decision[]>()
  for (const row of rows) {
    if (!row.outcome) continue
    const key = `${row.tier}\u0000${family(row.outcome.model)}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  const out: Summary[] = []
  for (const [key, group] of groups) {
    const [tier = '', model = ''] = key.split('\u0000')
    const calls = group.map(row => row.outcome?.toolCalls ?? 0)
    const errors = group.reduce((sum, row) => sum + (row.outcome?.toolErrors ?? 0), 0)
    const outputs = group.map(row => row.outcome?.output ?? 0)
    out.push({
      tier,
      model,
      n: group.length,
      medianToolCalls: median(calls),
      errorRate: group.length ? errors / group.length : 0,
      medianOutput: median(outputs),
      respawnRate: group.length ? group.filter(row => row.respawn).length / group.length : 0,
    })
  }
  return out.sort((a, b) => b.n - a.n)
}

export function formatRecent(rows: readonly Decision[], count: number): string[] {
  return rows.slice(-count).map(row => {
    const change =
      row.tier === 'deny'
        ? 'denied'
        : row.picked && row.picked !== row.asked
          ? `${row.asked || 'inherit'} → ${row.picked}`
          : `kept ${row.asked || 'inherit'}`
    const flags = [row.mode === 'shadow' ? 'shadow' : '', row.respawn ? 'respawn' : ''].filter(Boolean).join(',')
    const cost = row.outcome
      ? `${row.outcome.toolCalls} calls, ${row.outcome.toolErrors} err, ${kilo(row.outcome.output)} out, ${family(row.outcome.model)}`
      : 'running'
    return `  ${row.tier.padEnd(7)} ${change.padEnd(18)} ${row.reason.padEnd(26)} ${row.description.slice(0, 36).padEnd(36)} ${cost}${flags ? ` [${flags}]` : ''}`
  })
}

export function formatStats(rows: readonly Decision[]): string[] {
  const summary = summarize(rows)
  if (summary.length === 0) return ['no finished subagents recorded yet']
  const head = `  ${'tier'.padEnd(8)}${'model'.padEnd(8)}${'n'.padStart(4)}  ${'calls'.padStart(6)}  ${'err/agent'.padStart(9)}  ${'out tok'.padStart(8)}  respawn`
  const lines = summary.map(
    s =>
      `  ${s.tier.padEnd(8)}${s.model.padEnd(8)}${String(s.n).padStart(4)}  ${String(s.medianToolCalls).padStart(6)}  ${s.errorRate.toFixed(1).padStart(9)}  ${kilo(s.medianOutput).padStart(8)}  ${Math.round(s.respawnRate * 100)}%`,
  )
  return [head, ...lines]
}

/** `claude-sonnet-5-5` to `sonnet`; an alias stays itself. */
export function family(model: string): string {
  const hit = /(opus|sonnet|haiku|fable)/i.exec(model)
  return hit && hit[1] ? hit[1].toLowerCase() : model
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function kilo(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}
