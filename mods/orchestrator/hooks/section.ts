// The delegation section of the system prompt: facts the main model cannot
// see from inside the conversation, and two mechanical constraints. No
// thresholds, no rules about when to delegate: a capable model derives those
// from the economics, and derives different ones for different repos.
//
// Built once per session, from the agents that actually registered and the
// model the first render is for, then frozen. prompt.compose fires on every
// render, and text that changes between renders invalidates the prompt cache.

import type { AgentSpecLike } from './agents'

export const SECTION_ID = 'orchestrator:delegation'

/** What each agent is for, in the words the section uses. */
const ROLE: Record<AgentSpecLike['name'], string> = {
  scout: 'read-only search',
  researcher: 'web lookups',
  worker: 'a bounded change with tests',
  verifier: 'runs suites and browser flows',
}

/** Relative cost of putting a token into a model's context, by family, with
 * Haiku as 1: the ratio of list cache-write prices, rounded. Fable is priced
 * with Opus until its own rate is known. Only ratios are used, so a price
 * change across the board changes nothing here. */
const COST_WEIGHT: Record<string, number> = { haiku: 1, sonnet: 20, opus: 40, fable: 40 }

const WORDS: Record<number, string> = { 2: 'two', 20: 'twenty', 40: 'forty' }

export type SectionOptions = {
  /** The model the prompt is rendered for; sets the read-cost ratio. */
  mainModel?: string
  /** The subagent-type prefix the engine registered the agents under. */
  prefix?: string
  facts?: readonly string[]
}

/** The section for the agents that registered. Empty when none did: a prompt
 * that names agents the engine does not have would send the model to spawn
 * them and fail. */
export function buildSection(specs: readonly AgentSpecLike[], reportLines: number, options: SectionOptions = {}): string {
  if (specs.length === 0) return ''
  const prefix = options.prefix ?? 'orchestrator'
  const facts = options.facts ?? []
  const listed = specs.map(spec => `${prefix}:${spec.name} (${ROLE[spec.name]}, ${titleCase(family(spec.model))})`).join(', ')
  const cheapest = [...specs].sort((a, b) => weight(a.model) - weight(b.model))[0]!
  const ratio = Math.round(weight(options.mainModel ?? '') / weight(cheapest.model))
  const lines = [
    '# Delegation',
    '',
    `The main model's context re-reads and its output are the main cost of a session, and subagents run on cheaper models. ${countWord(specs.length)} named ${specs.length === 1 ? 'agent is' : 'agents are'} available as subagent types: ${listed}. A subagent starts with no context and rebuilds what it needs; the main context grows only by its report. ${readCost(ratio, cheapest.name)} Use that to decide what to delegate and what to keep.`,
    '',
    `Every report comes back findings first, with file paths, within ${reportLines} lines. Never spawn an agent to wait for another; end the turn and the notification will wake you.`,
  ]
  if (facts.length > 0) {
    lines.push('', 'Observed on this machine:', ...facts.map(fact => `- ${fact}`))
  }
  return lines.join('\n')
}

function readCost(ratio: number, agent: string): string {
  if (ratio >= 4) {
    return `Reading a file into this context costs roughly ${WORDS[ratio] ?? String(ratio)} times what a ${agent} pays to read it, and the text then rides along in every later request; when work is mostly reading across independent files, ${agent}s in parallel are usually the cheaper path.`
  }
  return `Reading a file into this context costs about the same per token as a ${agent} reading it, but the text then rides along in every later request; delegation pays here through parallel work and a short report, not through the model price.`
}

/** A model's cost weight; an unknown family is taken as the main model's
 * usual class, Opus, so the ratio errs toward delegating reads. */
function weight(model: string): number {
  return COST_WEIGHT[family(model)] ?? COST_WEIGHT['opus']!
}

/** `claude-sonnet-5-5` to `sonnet`; an alias stays itself. */
export function family(model: string): string {
  const hit = /(opus|sonnet|haiku|fable)/i.exec(model)
  return hit && hit[1] ? hit[1].toLowerCase() : model
}

function countWord(n: number): string {
  return ['Zero', 'One', 'Two', 'Three', 'Four'][n] ?? String(n)
}

function titleCase(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : word
}
