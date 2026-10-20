# local-router

A Claude Code mod that picks each subagent's model by task complexity, on your machine. Heavy work (build, implement, fix, refactor, design, review, plan) goes to Opus. Light work (validate, verify, compare, summarize, write tests) goes to Sonnet. Read-only work (research, search, find, list) goes to Haiku.

No server, no network. `claude plugin validate` lists every engine call the mod makes; there is no `http.fetch` among them.

## Install

At the prompt of a terminal session:

```
/plugin install local-router --marketplace smhnkmr/ai-plugins
```

From a shell:

```
claude plugin install local-router --marketplace smhnkmr/ai-plugins
```

To try it from a clone for one session:

```
claude --plugin-dir ./mods/local-router
```

## What it does

On every `agent.spawn` the mod decides a tier and rewrites the spawn's `model`:

| Tier | Signal | Default model |
| --- | --- | --- |
| pinned | the agent definition's frontmatter declares `model:` | unchanged |
| trivial | agent type `Explore` or `claude-code-guide`; a tool allowlist of read and search tools only; verbs like research, search, find, list, fetch | `haiku` |
| heavy | agent type `Plan`; browser or Playwright work; verbs like build, implement, fix, refactor, migrate, design, review, plan | `opus` |
| light | verbs like validate, verify, check, compare, summarize, test, draft, upload | `sonnet` |
| inherit | no signal | unchanged |

Rules apply in that order. Heavy verbs beat light verbs beat trivial ones when a prompt holds several. The verb scan reads the description plus the first 500 characters of the prompt.

A spawn whose model already matches gets no toast. One that changes shows a line to you, never to the model:

```
router · trivial → haiku (asked sonnet) · verb "research" · Research booking date reads
```

Every decision is kept in the plugin's store, last 200. `/router` prints the configuration and the last ten. `/router off` and `/router on` flip the switch.

## Configuration

Each field is a row in `/config`:

| Field | Default | Purpose |
| --- | --- | --- |
| Routing enabled | on | master switch |
| Heavy tasks | opus | opus, fable or sonnet |
| Light tasks | sonnet | sonnet, haiku or opus |
| Trivial tasks | haiku | haiku or sonnet |
| Show a toast per routed spawn | on | the one-line notice |

## Failure is silence

No definition file, an unreadable one, a store that cannot be written, a thrown error anywhere: the hook returns `next(e)` and the spawn runs exactly as Claude proposed. Forks are never touched.

## Development

```
claude plugin validate ./mods/local-router
claude plugin test ./mods/local-router
```

The policy lives in `hooks/policy.ts` as plain functions. The verb lists at its top are the knobs to tune.

## Roadmap

Outcome feedback on `turn.complete`, a split warning for long runs, rate-limit aware tiers, and effort reduction on notification-driven turns. The design is in the project notes.
