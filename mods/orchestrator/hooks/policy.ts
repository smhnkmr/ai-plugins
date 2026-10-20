// The repo's overrides, read from .claude/orchestrator.json. Plain parsing, no
// engine access. Anything that is not the documented shape is dropped field
// by field; a file that is not JSON at all is no policy.

export type AgentName = 'scout' | 'researcher' | 'worker' | 'verifier'
export const AGENT_NAMES: readonly AgentName[] = ['scout', 'researcher', 'worker', 'verifier']

export type AgentOverride = { model?: string; tools?: string[] }

export type OrchestratorPolicy = {
  /** Per-agent model or tool overrides: `{ "worker": { "model": "opus" } }`. */
  agents?: Partial<Record<AgentName, AgentOverride>>
  /** Extra fact lines appended to the delegation section, as written. */
  facts?: string[]
  /** The report line cap; beats userConfig. */
  report_lines?: number
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const TOOL_NAME = /^[A-Za-z0-9_:-]{1,128}$/
const FACT_MAX = 300

export function parseOrchestratorPolicy(text: string): OrchestratorPolicy | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  const source = asRecord(raw)
  if (!source) return undefined
  const policy: OrchestratorPolicy = {}

  const agents = asRecord(source.agents)
  if (agents) {
    const kept: Partial<Record<AgentName, AgentOverride>> = {}
    for (const name of AGENT_NAMES) {
      const entry = asRecord(agents[name])
      if (!entry) continue
      const override: AgentOverride = {}
      if (typeof entry.model === 'string' && MODEL_NAME.test(entry.model)) override.model = entry.model
      if (Array.isArray(entry.tools)) {
        const tools = entry.tools.filter((tool): tool is string => typeof tool === 'string' && TOOL_NAME.test(tool))
        if (tools.length > 0) override.tools = tools
      }
      if (Object.keys(override).length > 0) kept[name] = override
    }
    if (Object.keys(kept).length > 0) policy.agents = kept
  }

  if (Array.isArray(source.facts)) {
    const facts = source.facts
      .filter((fact): fact is string => typeof fact === 'string')
      .map(fact => fact.trim().replace(/\s+/g, ' '))
      .filter(fact => fact.length > 0 && fact.length <= FACT_MAX)
    if (facts.length > 0) policy.facts = facts
  }

  const lines = source.report_lines
  if (typeof lines === 'number' && Number.isFinite(lines) && lines >= 10 && lines <= 200) policy.report_lines = Math.round(lines)

  return Object.keys(policy).length > 0 ? policy : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
