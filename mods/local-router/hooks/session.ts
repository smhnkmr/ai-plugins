// The session tagger, shadow only. Reads the first substantive prompt of a
// session, says what kind of session it opens and which tier the main model
// would need for it, and records that next to what the session then actually
// ran: the model, the main-loop output, the spawns, the later prompts that
// escalated or corrected. It never rewrites a model. A week of these records
// is what decides whether the pick is safe to apply.
//
// Why the first prompt: the prompt cache is per model, so a switch after the
// first call rewrites the whole prefix and costs more than a short turn
// saves. Before the first call nothing is cached and the pick is free.

import type { EngineInterface } from 'claude-code'

import { family } from './outcomes'
import type { Tier } from './policy'

export type SessionKind = 'lookup' | 'bounded' | 'heavy' | 'ambiguous'

export type SessionTag = {
  kind: SessionKind
  /** The tier the main model would run at; `inherit` keeps the user's choice. */
  tier: Tier
  reason: string
  /** The head of the prompt that was tagged, for reading the record later. */
  prompt: string
}

export type SessionRecord = {
  id: string
  startedAt: number
  isInteractive: boolean
  tag?: SessionTag
  /** What the pick would have run; empty when the tag inherits. */
  wouldRun?: string
  /** The model and effort the first main-loop request actually used. */
  actualModel?: string
  actualEffort?: string
  mainSteps: number
  mainTurns: number
  mainOutput: number
  spawns: number
  /** Later prompts that read as heavy work: the session outgrew its tag. */
  laterHeavy: number
  /** Later prompts that read as a correction of the model's work. */
  corrections: number
  prompts: number
}

export const SESSIONS_KEY = 'sessions'
export const SESSIONS_KEPT = 100
export const PROMPT_HEAD = 120
export const SESSION_WINDOW = 600

/** Work that needs judgement across files: the user's own model. */
export const HEAVY_SESSION =
  /\b(implement|build|feature|debug|diagnose|investigate|root[- ]cause|why (?:does|is|do|did|are|won't|doesn't|isn't)|fail(?:s|ed|ing|ure)?|broken|crash(?:es|ed|ing)?|design|architect|review|audit|refactor|migrate|rewrite|figure out|plan|optimi[sz]e|performance)\b/i

/** A question or a reading task: nothing to orchestrate but a report. */
export const LOOKUP_SESSION =
  /^(?:what|where|which|how|who|when|is|are|does|do|can|could|should|explain|show|list|summari[sz]e|describe|tell me|recap|find|look\s*up|search|read)\b|\?\s*$/i

/** A change small enough to specify in one line, named by a file or symbol. */
export const BOUNDED_VERB = /\b(add|change|rename|update|remove|delete|replace|move|set|edit|write|bump|tweak|adjust|insert|append|extract|wire|hook up|fix(?:\s+the)?\s+typo)\b/i
export const CODE_REF = /(?:[\w-]+\/)+[\w.-]+|[\w-]+\.(?:tsx?|jsx?|py|md|json|ya?ml|css|scss|html|go|rs|java|cs|rb|php|sql|sh|toml)\b|`[^`]+`/

/** A prompt that pushes back on what the model did. */
export const CORRECTION =
  /^(?:no\b|nope|wrong|not (?:that|what|quite|right)|that'?s (?:wrong|not|incorrect)|undo|revert|roll ?back|stop\b|don'?t\b|you (?:broke|missed|forgot|ignored))/i

/** Prompts that carry no task: acknowledgements, continuations, one word. */
const NOT_SUBSTANTIVE = /^(?:ok(?:ay)?|y(?:es)?|no|sure|go(?: ahead)?|continue|proceed|resume|next|thanks?(?: you)?|hi|hello|hey|recap|status|done|k|yep|yeah|nah|lgtm)\b[\s.!]*$/i
const MIN_PROMPT = 12

export function isSubstantive(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < MIN_PROMPT) return false
  if (trimmed.startsWith('/')) return false
  return !NOT_SUBSTANTIVE.test(trimmed)
}

/** The session's kind and tier from its first prompt. Heavy beats the rest
 * when several match: "explain why the build fails" is a debugging session.
 * Ambiguity resolves to the user's own model. */
export function classifySession(text: string, isInteractive: boolean): SessionTag {
  const trimmed = text.trim()
  const head = trimmed.slice(0, SESSION_WINDOW)
  const prompt = trimmed.replace(/\s+/g, ' ').slice(0, PROMPT_HEAD)
  if (HEAVY_SESSION.test(head)) {
    return { kind: 'heavy', tier: 'inherit', reason: 'judgement verbs', prompt }
  }
  if (LOOKUP_SESSION.test(head) && !BOUNDED_VERB.test(head)) {
    return { kind: 'lookup', tier: isInteractive ? 'light' : 'trivial', reason: isInteractive ? 'a question' : 'headless question', prompt }
  }
  if (BOUNDED_VERB.test(head) && CODE_REF.test(head)) {
    return { kind: 'bounded', tier: 'light', reason: 'one change, file named', prompt }
  }
  if (LOOKUP_SESSION.test(head)) {
    return { kind: 'lookup', tier: isInteractive ? 'light' : 'trivial', reason: isInteractive ? 'a question' : 'headless question', prompt }
  }
  return { kind: 'ambiguous', tier: 'inherit', reason: 'no clear signal', prompt }
}

export function freshSession(id: string, startedAt: number, isInteractive: boolean): SessionRecord {
  return { id, startedAt, isInteractive, mainSteps: 0, mainTurns: 0, mainOutput: 0, spawns: 0, laterHeavy: 0, corrections: 0, prompts: 0 }
}

export async function listSessions($: EngineInterface): Promise<SessionRecord[]> {
  try {
    const held = await $.store.get(SESSIONS_KEY)
    return Array.isArray(held) ? (held as SessionRecord[]) : []
  } catch {
    return []
  }
}

export async function saveSession($: EngineInterface, record: SessionRecord): Promise<void> {
  if (!record.id) return
  try {
    const rest = (await listSessions($)).filter(row => row.id !== record.id)
    await $.store.set(SESSIONS_KEY, [...rest, record].slice(-SESSIONS_KEPT))
  } catch {
    /* a record that cannot be written is one fewer data point */
  }
}

/** This session's line, then every tagged session grouped by what the pick
 * would have run: how often the session outgrew the tag, how often the user
 * pushed back, how much the main loop produced. The comparison that decides
 * whether the pick can go live. */
export function formatSessions(current: SessionRecord, all: readonly SessionRecord[]): string[] {
  const lines = [describe(current)]
  const tagged = all.filter(row => row.tag)
  if (tagged.length === 0) return [...lines, '  no tagged sessions yet on this machine']
  const groups = new Map<string, SessionRecord[]>()
  for (const row of tagged) {
    const key = `${row.tag?.kind ?? ''} → ${row.wouldRun || 'own model'}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  lines.push(`  ${'tag'.padEnd(24)}${'n'.padStart(4)}  ${'outgrew'.padStart(8)}  ${'pushback'.padStart(8)}  ${'spawns'.padStart(7)}  ${'main out'.padStart(9)}  ran`)
  for (const [key, group] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const n = group.length
    const outgrew = group.filter(row => row.laterHeavy > 0).length
    const pushback = group.filter(row => row.corrections > 0).length
    const spawns = group.reduce((sum, row) => sum + row.spawns, 0) / n
    const output = group.reduce((sum, row) => sum + row.mainOutput, 0) / n
    const ran = [...new Set(group.map(row => family(row.actualModel ?? '')).filter(Boolean))].join(',')
    lines.push(
      `  ${key.padEnd(24)}${String(n).padStart(4)}  ${pct(outgrew, n).padStart(8)}  ${pct(pushback, n).padStart(8)}  ${spawns.toFixed(1).padStart(7)}  ${kilo(output).padStart(9)}  ${ran}`,
    )
  }
  return lines
}

function describe(record: SessionRecord): string {
  if (!record.tag) return '  this session: not tagged yet (no substantive prompt seen)'
  const would = record.wouldRun ? `would run ${record.wouldRun}` : 'keeps your model'
  const ran = record.actualModel ? `ran ${family(record.actualModel)}${record.actualEffort ? ` at ${record.actualEffort}` : ''}` : 'no request yet'
  return `  this session: ${record.tag.kind} (${record.tag.reason}) · ${would} · ${ran} · ${record.prompts} prompts, ${record.spawns} spawns, ${record.laterHeavy} outgrew, ${record.corrections} pushback · "${record.tag.prompt}"`
}

function pct(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : '0%'
}

function kilo(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value))
}
