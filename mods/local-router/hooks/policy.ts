// The routing policy, as plain code: no engine access, so every rule here is
// testable with a string in and a verdict out. register.ts feeds it what the
// spawn carries and what the agent definition on disk says.

export type Tier = 'heavy' | 'light' | 'trivial' | 'inherit'

export type Verdict = { tier: Tier; reason: string }

/** What `.claude/agents/<type>.md` frontmatter declares, when it exists. */
export type AgentDefinition = { model?: string; tools?: string[] }

export type SpawnFacts = {
  subagentType: string
  description: string
  prompt: string
  definition?: AgentDefinition
}

/** Tools that read and search but never change anything. An agent limited to
 * these is a research agent by construction, whatever its prompt says. */
export const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'ToolSearch',
])

export const TRIVIAL_AGENT_TYPES = new Set(['Explore', 'claude-code-guide'])
export const HEAVY_AGENT_TYPES = new Set(['Plan'])

/** How much of the prompt the verb scan reads. The task is almost always
 * stated up front; the rest is material. */
export const PROMPT_WINDOW = 500

// Heavy beats light beats trivial when several match: "research the options
// and implement one" is a build task, "verify by searching" is a check.
export const VERBS: Record<Exclude<Tier, 'inherit'>, RegExp> = {
  heavy:
    /\b(build|implement|make|create|develop|write\s+(?:the\s+)?code|code\s+up|fix|debug|repair|refactor|migrate|design|architect|review|audit|plan|upgrade|rewrite|optimi[sz]e)\b/i,
  light:
    /\b(validate|verify|check|confirm|compare|test|summari[sz]e|draft|document|upload|format|lint|triage|classify)\b/i,
  trivial:
    /\b(research|search|find|look\s*up|list|fetch|scan|explore|collect|gather|read|locate|browse|enumerate)\b/i,
}

/** A task that drives a browser is long-horizon tool work however it is
 * worded. Measured on this machine: Sonnet needed a third more turns and
 * more tool errors than Opus on these, at the same wall-clock. */
export const BROWSER = /playwright|\bbrowser\b|screenshot|\be2e\b|end[- ]to[- ]end|live[- ]run/i

export function classify(facts: SpawnFacts): Verdict {
  const type = facts.subagentType
  if (TRIVIAL_AGENT_TYPES.has(type)) return { tier: 'trivial', reason: `agent type ${type}` }
  if (HEAVY_AGENT_TYPES.has(type)) return { tier: 'heavy', reason: `agent type ${type}` }

  const tools = facts.definition?.tools
  if (tools && tools.length > 0 && tools.every(tool => READ_ONLY_TOOLS.has(tool))) {
    return { tier: 'trivial', reason: 'read-only tools' }
  }

  const text = `${facts.description}\n${facts.prompt.slice(0, PROMPT_WINDOW)}`
  if (BROWSER.test(text)) return { tier: 'heavy', reason: 'browser run' }

  for (const tier of ['heavy', 'light', 'trivial'] as const) {
    const hit = VERBS[tier].exec(text)
    if (hit) return { tier, reason: `verb "${hit[0].toLowerCase()}"` }
  }
  return { tier: 'inherit', reason: 'no signal' }
}

/** Reads `model:` and `tools:` out of an agent file's frontmatter. Tools may
 * be inline (`tools: Read, Grep`, with or without brackets) or a YAML list. */
export function parseAgentDefinition(text: string): AgentDefinition {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  const frontmatter = end === -1 ? text.slice(3) : text.slice(3, end)
  const out: AgentDefinition = {}

  const model = /^model:[ \t]*(\S+)/m.exec(frontmatter)
  if (model && model[1]) out.model = model[1]

  const inline = /^tools:[ \t]*([^\n]*)$/m.exec(frontmatter)
  const inlineValue = inline && inline[1] ? inline[1].trim() : ''
  if (inlineValue) {
    const list = splitList(inlineValue.replace(/^\[|\]$/g, ''))
    if (list.length > 0) out.tools = list
  } else {
    const block = /^tools:[ \t]*\n((?:[ \t]+-[ \t]*[^\n]+\n?)+)/m.exec(frontmatter)
    if (block && block[1]) {
      const list = block[1]
        .split('\n')
        .map(line => unquote(line.replace(/^[ \t]+-[ \t]*/, '')))
        .filter(Boolean)
      if (list.length > 0) out.tools = list
    }
  }
  return out
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map(item => unquote(item))
    .filter(Boolean)
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '')
}

/** True when the model Claude asked for already is the one the policy picked:
 * `sonnet` against `sonnet`, or against the id `claude-sonnet-5-5`. */
export function sameFamily(asked: string | undefined, picked: string): boolean {
  if (!asked) return false
  return asked.toLowerCase().includes(picked.toLowerCase())
}
