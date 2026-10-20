// The routing policy, as plain code: no engine access, so every rule here is
// testable with a string in and a verdict out. register.ts feeds it what the
// spawn carries, what the agent definition on disk says, and what the project
// policy file overrides.

export type Tier = 'heavy' | 'light' | 'trivial' | 'inherit'
export type RoutedTier = Exclude<Tier, 'inherit'>

export type Verdict = { tier: Tier; reason: string }

/** What `.claude/agents/<type>.md` frontmatter declares, when it exists. */
export type AgentDefinition = { model?: string; tools?: string[] }

/** What a repo's `.claude/router.json` may override. Every field optional. */
export type ProjectPolicy = {
  /** Agent type to tier: `{ "reviewer": "heavy" }`. Beats the built-in types. */
  agents?: Record<string, Tier>
  /** Tier to model: `{ "heavy": "fable" }`. Beats userConfig. */
  models?: Partial<Record<RoutedTier, string>>
  /** Extra words for a tier's verb list: `{ "heavy": ["baseline"] }`. */
  verbs?: Partial<Record<RoutedTier, string[]>>
}

export type SpawnFacts = {
  subagentType: string
  description: string
  prompt: string
  definition?: AgentDefinition
  policy?: ProjectPolicy
}

/** Tools that read and search but never change anything. An agent limited to
 * these is a research agent by construction, whatever its prompt says. */
export const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch'])

export const TRIVIAL_AGENT_TYPES = new Set(['Explore', 'claude-code-guide'])
export const HEAVY_AGENT_TYPES = new Set(['Plan'])
export const TIERS: readonly RoutedTier[] = ['heavy', 'light', 'trivial']

/** How much of the prompt the verb scan reads. The task is almost always
 * stated up front; the rest is material. */
export const PROMPT_WINDOW = 500

// Heavy beats light beats trivial when several match: "research the options
// and implement one" is a build task, "verify by searching" is a check.
export const VERBS: Record<RoutedTier, RegExp> = {
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

/** A spawn that exists to park a task, not to do one: a few characters of
 * prompt and a description that says so. Eight of these in a month here,
 * each a Sonnet subagent started to wait. */
export const PLACEHOLDER = /\b(no-?op|placeholder|wait|cancel|dummy|idle|sleep)\b/i
export const PLACEHOLDER_MAX_PROMPT = 50

/** The one sentence the model reads when a placeholder spawn is refused. It
 * names what to do instead. */
export const PLACEHOLDER_DENY =
  'local-router: this spawn is a placeholder, not a task. To wait on background work, use the Monitor tool or end the turn and let the task notification wake you; do not start a subagent to idle.'

export function isPlaceholder(facts: Pick<SpawnFacts, 'description' | 'prompt'>): boolean {
  if (facts.prompt.trim().length > PLACEHOLDER_MAX_PROMPT) return false
  return PLACEHOLDER.test(`${facts.description}\n${facts.prompt}`)
}

export function classify(facts: SpawnFacts): Verdict {
  const type = facts.subagentType
  const projectTier = facts.policy?.agents?.[type]
  if (projectTier) return { tier: projectTier, reason: `project policy for ${type}` }
  if (TRIVIAL_AGENT_TYPES.has(type)) return { tier: 'trivial', reason: `agent type ${type}` }
  if (HEAVY_AGENT_TYPES.has(type)) return { tier: 'heavy', reason: `agent type ${type}` }

  const tools = facts.definition?.tools
  if (tools && tools.length > 0 && tools.every(tool => READ_ONLY_TOOLS.has(tool))) {
    return { tier: 'trivial', reason: 'read-only tools' }
  }

  const text = `${facts.description}\n${facts.prompt.slice(0, PROMPT_WINDOW)}`
  if (BROWSER.test(text)) return { tier: 'heavy', reason: 'browser run' }

  for (const tier of TIERS) {
    const extra = facts.policy?.verbs?.[tier]
    const hit = VERBS[tier].exec(text) ?? (extra && extra.length > 0 ? wordList(extra).exec(text) : null)
    if (hit) return { tier, reason: `verb "${hit[0].toLowerCase()}"` }
  }
  return { tier: 'inherit', reason: 'no signal' }
}

/** A regex over a list of words or phrases, whole-word, case-insensitive. */
export function wordList(words: readonly string[]): RegExp {
  const parts = words
    .map(word => word.trim())
    .filter(Boolean)
    .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
  return new RegExp(`\\b(${parts.join('|')})\\b`, 'i')
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

const TIER_NAMES = new Set<string>(['heavy', 'light', 'trivial', 'inherit'])
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

/** Reads `.claude/router.json`. Anything that is not the documented shape is
 * dropped field by field; a file that is not JSON at all is no policy. */
export function parseProjectPolicy(text: string): ProjectPolicy | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const source = raw as Record<string, unknown>
  const policy: ProjectPolicy = {}

  const agents = asRecord(source.agents)
  if (agents) {
    const kept: Record<string, Tier> = {}
    for (const [agent, tier] of Object.entries(agents)) {
      if (typeof tier === 'string' && TIER_NAMES.has(tier)) kept[agent] = tier as Tier
    }
    if (Object.keys(kept).length > 0) policy.agents = kept
  }

  const models = asRecord(source.models)
  if (models) {
    const kept: Partial<Record<RoutedTier, string>> = {}
    for (const tier of TIERS) {
      const model = models[tier]
      if (typeof model === 'string' && MODEL_NAME.test(model)) kept[tier] = model
    }
    if (Object.keys(kept).length > 0) policy.models = kept
  }

  const verbs = asRecord(source.verbs)
  if (verbs) {
    const kept: Partial<Record<RoutedTier, string[]>> = {}
    for (const tier of TIERS) {
      const words = verbs[tier]
      if (Array.isArray(words)) {
        const list = words.filter((word): word is string => typeof word === 'string' && word.trim().length > 0)
        if (list.length > 0) kept[tier] = list
      }
    }
    if (Object.keys(kept).length > 0) policy.verbs = kept
  }

  return Object.keys(policy).length > 0 ? policy : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
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

// Words a retry adds to a description without changing the task.
const RETRY_WORDS = /\b(resume|retry|re-?run|re-?verify|again|continue|second|another|v\d+|mcp|run)\b/gi
const SMALL_WORDS = /\b(the|a|an|of|on|in|for|to|and|with|from|by|at)\b/gi

/** True when two descriptions name the same task: the same words once retry
 * wording and filler are dropped, by Jaccard overlap. The cheapest proxy for
 * "the first attempt did not do the job". */
export function describesSameTask(a: string, b: string): boolean {
  const left = words(a)
  const right = words(b)
  if (left.size === 0 || right.size === 0) return false
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  const union = left.size + right.size - shared
  // 0.65: "Resume reports live baseline" against "Live-run reports baseline"
  // is 1.0 once retry words go; "Write teesheet test cases" against "Write
  // inventory test cases" is 0.6, a different module, and must not count.
  return shared / union >= 0.65
}

function words(text: string): Set<string> {
  const cleaned = text.toLowerCase().replace(RETRY_WORDS, ' ').replace(SMALL_WORDS, ' ')
  return new Set(cleaned.split(/[^a-z0-9]+/).filter(word => word.length > 2))
}
