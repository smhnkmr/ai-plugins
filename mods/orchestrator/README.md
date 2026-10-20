# orchestrator

A Claude Code mod that makes the main model an orchestrator. The main model stays whatever you set. The mod gives it four named cheap agents to delegate to and the facts it needs to decide what to delegate, as one section of the system prompt. A switch in `/config`; nothing is ever said in a prompt.

No server, no network. `claude plugin validate` lists every engine call the mod makes.

## Install

```
/plugin install orchestrator --marketplace smhnkmr/ai-plugins
```

Start a fresh session afterwards so the section enters the prompt cache cleanly. Toggling mid-session works, at the cost of one prefix cache rewrite.

## What the main model gets

Four agents, registered at session start and listed to the model as subagent types:

| Agent | Model | Tools | Use when |
| --- | --- | --- | --- |
| `orchestrator:scout` | haiku | Read, Grep, Glob | find where things live, map layout, list call sites |
| `orchestrator:researcher` | haiku | WebFetch, WebSearch, Read | look something up outside the repo |
| `orchestrator:worker` | sonnet | Read, Grep, Glob, Edit, Write, Bash | one bounded change with tests |
| `orchestrator:verifier` | sonnet | everything except Edit and Write | run a suite or browser flow and report failures |

Each agent's own prompt ends with the report contract: findings first, file paths, within the configured line cap, no restating the task.

And one section appended to the system prompt, built once per session:

> **Delegation.** You are working on a subscription where the main model's context re-reads and output are the main cost, and subagents run on cheaper models. Four named agents are available as subagent types: orchestrator:scout (read-only search, Haiku), orchestrator:researcher (web lookups, Haiku), orchestrator:worker (a bounded change with tests, Sonnet), orchestrator:verifier (runs suites and browser flows, Sonnet). A subagent starts with no context and rebuilds what it needs; the main context grows only by its report. Reading a file into this context costs roughly forty times what a scout pays to read it, and the text then rides along in every later request; when work is mostly reading across independent files, scouts in parallel are usually the cheaper path. Use that to decide what to delegate and what to keep. Every report comes back findings first, with file paths, within 40 lines. Never spawn an agent to wait for another; end the turn and the notification will wake you.

Facts, not rules. The model lacks three things it cannot see from inside the conversation: which agents exist, what delegation costs, and what has worked before. The section gives the first two; a repo can add the third. Thresholds like "delegate above ten tool calls" are deliberately absent: they freeze a guess and age with every model release.

## Configuration

| Field | Default | Purpose |
| --- | --- | --- |
| Orchestrator enabled | on | the switch |
| Worker model | sonnet | sonnet or opus |
| Verifier model | sonnet | sonnet or opus |
| Report length | 40 | the line cap in every agent's contract and the section |

A repo can override with `.claude/orchestrator.json` at its root:

```json
{
  "agents": {
    "worker": { "model": "opus" },
    "verifier": { "tools": ["Bash", "Read", "mcp__playwright__browser_navigate"] }
  },
  "facts": ["A worker cold start here costs about fifteen main-loop steps."],
  "report_lines": 30
}
```

`facts` lines are appended to the section under "Observed on this machine". A missing or malformed file is ignored.

## Seeing what it does

`/orchestrate` prints the mode, the four agents with their models and whether each registered, and this session's counts: named spawns, generic spawns, main-loop turns, main-loop output tokens, median report length. `/orchestrate on` and `/orchestrate off` flip the switch. A toast at session start says it is on and how many agents registered.

Two numbers say whether orchestration is helping: the share of named spawns, and main-loop output per turn. Both are kept per session in the plugin's store, last 100 sessions. If the model over-delegates, add a fact about cold-start cost; if it under-delegates, add one about what a long run costs inline. Tune with facts, not rules.

Measured on a 314-file Angular app with Opus as the main model: a mechanical survey (which services each component injects) was scripted inline in 11 Bash calls, no spawn, and that is the cheapest path for it. A survey that needs code read for meaning (a plain-English summary per feature folder) went to seven parallel scouts, with the main loop doing the grep itself; its own context traffic was a quarter of the scripted run's.

## With local-router

The two mods are independent. With both installed, the router respects the named agents' pinned models (they are declared in their definitions) and routes the main model's generic spawns as before. A later version of this mod can read the router's outcome stats to add evidence lines to the section automatically.

## Development

```
claude plugin validate ./mods/orchestrator
claude plugin test ./mods/orchestrator
```

| File | Holds |
| --- | --- |
| `hooks/agents.ts` | the four specs and the report contract |
| `hooks/section.ts` | the section text |
| `hooks/policy.ts` | the `.claude/orchestrator.json` parser |
| `hooks/register.ts` | the hooks: `session.start`, `prompt.compose`, `agent.spawn`, `turn.complete`, `/orchestrate` |
| `tests/orchestrator.test.ts` | 12 cases against the engine's test kit |
