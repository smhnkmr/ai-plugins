// The four named agents, as data. Each is an agent definition the engine
// registers under `orchestrator:<name>`; its `description` is the line the
// main model reads to decide when to use it, its `prompt` is its own system
// prompt, and its `model` is pinned so a router treats it as declared.

import type { AgentName, OrchestratorPolicy } from './policy'

export type AgentSettings = {
  worker: string
  verifier: string
  reportLines: number
}

export type AgentSpecLike = {
  name: AgentName
  description: string
  prompt: string
  model: string
  tools?: readonly string[]
  disallowedTools?: readonly string[]
}

type Base = Omit<AgentSpecLike, 'model' | 'prompt'> & { role: string }

const BASES: readonly Base[] = [
  {
    name: 'scout',
    description:
      'Finds where things live in this repo: definitions, call sites, module layout, which files touch a feature. Read-only. Use before changing code you have not seen, or when a question is "where" or "which files".',
    tools: ['Read', 'Grep', 'Glob'],
    role: 'You find things in a codebase and report where they are. You never edit, run or install anything.',
  },
  {
    name: 'researcher',
    description:
      'Looks something up outside the repo: documentation, an API, a library, an error message. Returns a sourced summary. Use when the answer is on the web, not in the code.',
    tools: ['WebFetch', 'WebSearch', 'Read'],
    role: 'You research questions on the web and report what you found with its source. You never edit or run anything.',
  },
  {
    name: 'worker',
    description:
      'Makes one bounded change from a clear brief: the files, the behaviour, the tests to run. Reports the diff summary and test results. Use for a change you can specify completely; not for exploration.',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
    role: 'You make one bounded change exactly as briefed, run the tests the brief names, and report what changed and what the tests said. You do not widen the scope; if the brief is incomplete, say what is missing and stop.',
  },
  {
    name: 'verifier',
    description:
      'Runs a test suite, a script or a browser flow end to end and reports failures with reproduction steps. Does not fix anything. Use to confirm a change works or to baseline behaviour.',
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    role: 'You run what you are asked to run and report the outcome: what passed, what failed, and how to reproduce each failure. You never change code.',
  },
]

/** The four specs with settings and repo overrides applied. */
export function agentSpecs(settings: AgentSettings, policy?: OrchestratorPolicy): AgentSpecLike[] {
  const reportLines = policy?.report_lines ?? settings.reportLines
  return BASES.map(base => {
    const override = policy?.agents?.[base.name]
    const model = override?.model ?? defaultModel(base.name, settings)
    const tools = override?.tools ?? base.tools
    const spec: AgentSpecLike = {
      name: base.name,
      description: base.description,
      model,
      prompt: `${base.role}\n\n${reportContract(reportLines)}`,
    }
    if (tools) spec.tools = tools
    if (base.disallowedTools && !override?.tools) spec.disallowedTools = base.disallowedTools
    return spec
  })
}

export function defaultModel(name: AgentName, settings: AgentSettings): string {
  switch (name) {
    case 'worker':
      return settings.worker
    case 'verifier':
      return settings.verifier
    default:
      return 'haiku'
  }
}

/** The report shape every agent is held to. The harness relays a subagent's
 * answer verbatim into the main context, so its length is a cost the main
 * model cannot otherwise control. */
export function reportContract(lines: number): string {
  return `Report back in at most ${lines} lines: findings first, then what you did, with file paths and line numbers where they apply. Do not restate the task. If you could not finish, say exactly where you stopped and why.`
}
