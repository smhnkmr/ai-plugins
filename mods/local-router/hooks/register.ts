// local-router: picks a subagent's model by task complexity, on this machine.
//
// One decision point, `agent.spawn`. The hook reads what the spawn carries and
// what the agent definition on disk declares, classifies the task with the
// policy in policy.ts, and rewrites `model` through `next`. A spawn the policy
// agrees with, or has nothing to say about, goes through untouched and silent.
// Every failure path ends in `next(e)`: the spawn runs as Claude proposed.
//
// Nothing leaves the machine. `claude plugin validate` lists every call this
// module makes; there is no http.fetch among them.

import type { EngineInterface, Register } from 'claude-code'

import { classify, parseAgentDefinition, sameFamily } from './policy'
import type { AgentDefinition, Tier } from './policy'

type Decision = {
  at: number
  agent: string
  description: string
  tier: Tier
  reason: string
  asked: string
  picked: string
  toolUseId: string
}

type Models = Record<Exclude<Tier, 'inherit'>, string>

const DECISIONS_KEY = 'decisions'
const DECISIONS_KEPT = 200
const DECISIONS_SHOWN = 10

// A subagent_type is a file name under .claude/agents; anything else is never
// opened.
const TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export const register: Register = (on, options) => {
  const enabled = options.enabled !== false
  const toasts = options.show_toasts !== false
  const models: Models = {
    heavy: pick(options.heavy_model, 'opus'),
    light: pick(options.light_model, 'sonnet'),
    trivial: pick(options.trivial_model, 'haiku'),
  }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'router',
        description: 'Local model router: status and the last decisions',
        argumentHint: '[on|off]',
      })
    } catch {
      /* the command is a convenience; routing works without it */
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    if (!enabled || e.fork || e.subagentType === 'fork') return next(e)

    const asked = e.model ?? ''
    const base = {
      at: await now($),
      agent: e.subagentType,
      description: e.description,
      asked,
      toolUseId: e.tool_use_id,
    }

    const definition = await readDefinition($, e.subagentType)
    if (definition?.model) {
      await record($, { ...base, tier: 'inherit', reason: 'declared in frontmatter', picked: asked })
      return next(e)
    }

    const { tier, reason } = classify({
      subagentType: e.subagentType,
      description: e.description,
      prompt: e.prompt,
      definition,
    })
    if (tier === 'inherit') {
      await record($, { ...base, tier, reason, picked: asked })
      return next(e)
    }

    // What the child would run on without us: the alias Claude asked for, or
    // the parent's model when it asked nothing. Already the right family means
    // nothing to change and nothing to say.
    const picked = models[tier]
    if (sameFamily(e.model ?? e.parentModel, picked)) {
      await record($, { ...base, tier, reason, picked: asked })
      return next(e)
    }

    const line = `router · ${tier} → ${picked}${asked ? ` (asked ${asked})` : ''} · ${reason} · ${e.description}`
    await record($, { ...base, tier, reason, picked })
    if (toasts) $.ui.toast(line)
    $.ui.log(line, { to: 'debug' })
    return next({ ...e, model: picked })
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'router' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      try {
        const result = (await $.config.set({ key: `${$.plugin.name}.enabled`, value: arg === 'on' })) as
          | { deny?: string }
          | undefined
        if (result && typeof result === 'object' && typeof result.deny === 'string') {
          return { text: `router: could not switch ${arg}: ${result.deny}. Use /config instead.` }
        }
        return { text: `router ${arg}` }
      } catch (error) {
        return { text: `router: could not switch ${arg}: ${String(error)}. Use /config instead.` }
      }
    }

    const head = `router ${enabled ? 'on' : 'off'} · heavy → ${models.heavy} · light → ${models.light} · trivial → ${models.trivial}`
    const recent = (await decisions($)).slice(-DECISIONS_SHOWN)
    if (recent.length === 0) return { text: `${head}\nno decisions yet this machine` }
    const rows = recent.map(d => {
      const change = d.picked && d.picked !== d.asked ? `${d.asked || 'inherit'} → ${d.picked}` : `kept ${d.asked || 'inherit'}`
      return `  ${d.tier.padEnd(7)} ${change.padEnd(18)} ${d.reason.padEnd(24)} ${d.description}`
    })
    return { text: [head, ...rows].join('\n') }
  })
}

function pick(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

async function now($: EngineInterface): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return 0
  }
}

/** The agent's definition file, project first then home; undefined when there
 * is none or it cannot be read. A rejected read is "no definition", never a
 * failed spawn. */
async function readDefinition($: EngineInterface, type: string): Promise<AgentDefinition | undefined> {
  if (!TYPE_RE.test(type)) return undefined
  let home = ''
  try {
    home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  } catch {
    home = ''
  }
  const paths = [`.claude/agents/${type}.md`]
  if (home) paths.push(`${home.replace(/[\\/]+$/, '')}/.claude/agents/${type}.md`)
  for (const path of paths) {
    try {
      return parseAgentDefinition(await $.fs.read(path))
    } catch {
      /* not there, or unreadable: try the next */
    }
  }
  return undefined
}

async function decisions($: EngineInterface): Promise<Decision[]> {
  try {
    const held = await $.store.get(DECISIONS_KEY)
    return Array.isArray(held) ? (held as Decision[]) : []
  } catch {
    return []
  }
}

async function record($: EngineInterface, decision: Decision): Promise<void> {
  try {
    const list = await decisions($)
    await $.store.set(DECISIONS_KEY, [...list, decision].slice(-DECISIONS_KEPT))
  } catch {
    /* the decision stands; only its record is lost */
  }
}
