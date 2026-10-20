// The delegation section of the system prompt: facts the main model cannot
// see from inside the conversation, and two mechanical constraints. No
// thresholds, no rules about when to delegate: a capable model derives those
// from the economics, and derives different ones for different repos.
//
// Built once per session and frozen. prompt.compose fires on every render,
// and text that changes between renders invalidates the prompt cache.

import type { AgentSpecLike } from './agents'

export const SECTION_ID = 'orchestrator:delegation'

export function buildSection(specs: readonly AgentSpecLike[], reportLines: number, facts: readonly string[] = []): string {
  const byName = new Map(specs.map(spec => [spec.name, spec]))
  const model = (name: string) => titleCase(family(byName.get(name as AgentSpecLike['name'])?.model ?? ''))
  const lines = [
    '# Delegation',
    '',
    `You are working on a subscription where the main model's context re-reads and output are the main cost, and subagents run on cheaper models. Four named agents are available as subagent types: orchestrator:scout (read-only search, ${model('scout')}), orchestrator:researcher (web lookups, ${model('researcher')}), orchestrator:worker (a bounded change with tests, ${model('worker')}), orchestrator:verifier (runs suites and browser flows, ${model('verifier')}). A subagent starts with no context and rebuilds what it needs; the main context grows only by its report. Use that to decide what to delegate and what to keep.`,
    '',
    `Every report comes back findings first, with file paths, within ${reportLines} lines. Never spawn an agent to wait for another; end the turn and the notification will wake you.`,
  ]
  if (facts.length > 0) {
    lines.push('', 'Observed on this machine:', ...facts.map(fact => `- ${fact}`))
  }
  return lines.join('\n')
}

/** `claude-sonnet-5-5` to `sonnet`; an alias stays itself. */
export function family(model: string): string {
  const hit = /(opus|sonnet|haiku|fable)/i.exec(model)
  return hit && hit[1] ? hit[1].toLowerCase() : model
}

function titleCase(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : word
}
