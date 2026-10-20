// What the router reads from the engine before deciding. Every read fails to
// "not known": a missing file, an unreadable one, a noun the host does not
// answer. A signal the router cannot get is a signal it decides without.

import type { EngineInterface } from 'claude-code'

import { parseAgentDefinition, parseProjectPolicy } from './policy'
import type { AgentDefinition, ProjectPolicy } from './policy'

// A subagent_type is a file name under .claude/agents; anything else is never
// opened.
const TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export const PROJECT_POLICY_FILE = '.claude/router.json'

export async function now($: EngineInterface): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return 0
  }
}

/** The agent's definition file, project first then home; undefined when there
 * is none or it cannot be read. */
export async function readDefinition($: EngineInterface, type: string): Promise<AgentDefinition | undefined> {
  if (!TYPE_RE.test(type)) return undefined
  const paths = [`.claude/agents/${type}.md`]
  const home = await homeDirectory($)
  if (home) paths.push(`${home}/.claude/agents/${type}.md`)
  for (const path of paths) {
    const text = await readText($, path)
    if (text !== undefined) return parseAgentDefinition(text)
  }
  return undefined
}

/** The repo's policy file, read on every decision: one small read, and no
 * cache to go stale when the session moves. Project root first, then the
 * working directory in case they differ. */
export async function readProjectPolicy($: EngineInterface): Promise<ProjectPolicy | undefined> {
  const paths: string[] = []
  try {
    const root = (await $.session.root()).replace(/[\\/]+$/, '')
    if (root) paths.push(`${root}/${PROJECT_POLICY_FILE}`)
  } catch {
    /* no root to read from: the relative path below still stands */
  }
  paths.push(PROJECT_POLICY_FILE)
  for (const path of paths) {
    const text = await readText($, path)
    if (text !== undefined) return parseProjectPolicy(text)
  }
  return undefined
}

async function homeDirectory($: EngineInterface): Promise<string> {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    return home.replace(/[\\/]+$/, '')
  } catch {
    return ''
  }
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}
