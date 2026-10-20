# local-router

A Claude Code mod that picks each subagent's model by task complexity, on your machine, and records what each subagent then cost. Heavy work (build, implement, fix, refactor, design, review, plan) goes to Opus. Light work (validate, verify, compare, summarize, write tests) goes to Sonnet. Read-only work (research, search, find, list) goes to Haiku.

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
| pinned | the agent definition's frontmatter declares `model:`, or the agent is a plugin's registered one (`orchestrator:verifier`), whose definition carries its model | unchanged |
| deny | a placeholder spawn: a prompt under 50 characters whose description says noop, wait, placeholder, cancel or idle | refused, with a sentence telling the model to use the Monitor tool or a timer instead |
| project | the repo's `.claude/router.json` names a tier for this agent type | per the file |
| trivial | agent type `Explore` or `claude-code-guide`; a tool allowlist of read and search tools only; verbs like research, search, find, list, fetch | `haiku` |
| heavy | agent type `Plan`; browser or Playwright work; verbs like build, implement, fix, refactor, migrate, design, review, plan | `opus` |
| light | verbs like validate, verify, check, compare, summarize, test, draft, upload | `sonnet` |
| inherit | no signal | unchanged |

Rules apply in that order. Heavy verbs beat light verbs beat trivial ones when a prompt holds several. The verb scan reads the description plus the first 500 characters of the prompt. Forks are never touched.

A spawn whose model already matches gets no toast. One that changes shows a line to you, never to the model:

```
router · trivial → haiku (asked sonnet) · verb "research" · Research booking date reads
```

### Outcomes

When a routed subagent finishes, the mod attaches what it cost to the decision: the model that answered, why the run ended, duration, tokens in four buckets, tool calls, tool errors, and how many turns it took. A spawn whose description matches a task spawned in the last fifteen minutes is flagged as a respawn, the cheapest sign that the first attempt did not do the job.

`/router` prints the configuration and the last ten decisions with their outcomes. `/router stats` prints, per tier and model, how many ran, median tool calls, tool errors per agent, median output tokens and the respawn rate. Both read the plugin's store, last 200 decisions, which survives sessions.

### Modes

| Mode | What happens |
| --- | --- |
| act | decisions are applied |
| shadow | every decision is made, recorded and shown with a `(shadow)` tag, and nothing changes; a placeholder is logged as a deny and still spawns |
| off | nothing |

`/router on`, `/router shadow` and `/router off` switch between them; so does the Mode row in `/config`. Shadow is how a new rule is watched for a week before it is allowed to act.

### Project policy

A repo can override the defaults with `.claude/router.json` at its root. Every field is optional:

```json
{
  "agents": { "reviewer": "heavy", "Explore": "trivial" },
  "models": { "heavy": "fable" },
  "verbs": { "heavy": ["baseline", "migration run"], "trivial": ["grep"] }
}
```

`agents` maps an agent type to a tier and beats the built-in types. `models` maps a tier to a model and beats the `/config` values. `verbs` adds whole words or phrases to a tier's list. Precedence overall: frontmatter model, then this file, then `/config`, then the built-in table. A missing or malformed file is ignored.

### Session tagger (shadow)

The main model's own cost is mostly re-reads of its context, and the prompt cache is per model, so the only free moment to pick the main model is before its first call. The tagger reads the first substantive prompt of a session and records what kind of session it opens and which tier the main model would need:

| First prompt | Kind | Would run |
| --- | --- | --- |
| implement, build, debug, why does X fail, design, review, refactor, plan | heavy | your model, unchanged |
| a question: where, which, how, explain, summarize, or ends in `?` | lookup | the light model; the trivial model under `claude -p` |
| one change with a file or symbol named: add, rename, update, remove, wire | bounded | the light model |
| anything else | ambiguous | your model, unchanged |

It then records what the session actually did: the model and effort of the first main-loop request, main-loop turns and output tokens, spawns, later prompts that read as heavier work (the tag was too low), and later prompts that read as pushback ("no, that's wrong", "revert"). Nothing is rewritten. A toast at the first prompt says what the pick would have been.

`/router session` prints this session's line and, for every tagged session on this machine, grouped by what the pick would have run: how often the session outgrew its tag, how often you pushed back, spawns and main-loop output per session, and what it actually ran. When the lookup and bounded groups show pushback and escalation rates no worse than the heavy group over a week or two, the pick is safe to apply with a one-way escalation; until then it stays a record. Slash commands, acknowledgements and prompts the engine injects are not tagged.

## Configuration

Each field is a row in `/config`:

| Field | Default | Purpose |
| --- | --- | --- |
| Mode | act | act, shadow or off |
| Heavy tasks | opus | opus, fable or sonnet |
| Light tasks | sonnet | sonnet, haiku or opus |
| Trivial tasks | haiku | haiku or sonnet |
| Session tagger | shadow | shadow or off; see above |
| Show a toast per routed spawn | on | the one-line notice |

## Failure is silence

No definition file, an unreadable one, a store that cannot be written, a thrown error anywhere: the spawn hook returns `next(e)` and the spawn runs exactly as Claude proposed. The outcome hooks observe only; one that fails is skipped and the subagent is unaffected.

## Development

```
claude plugin validate ./mods/local-router
claude plugin test ./mods/local-router
```

| File | Holds |
| --- | --- |
| `hooks/policy.ts` | the rules, as plain functions: verb lists, tiers, placeholder test, frontmatter and policy-file parsers, same-task test |
| `hooks/session.ts` | the session tagger: classifier, record, `/router session` text |
| `hooks/signals.ts` | what is read from the engine: definition files, the policy file, the clock |
| `hooks/outcomes.ts` | the decision store, outcome attachment, summaries and the `/router` text |
| `hooks/register.ts` | the hooks: `agent.spawn`, `tool.call`, `turn.complete`, `session.start`, `/router` |
| `tests/router.test.ts` | 37 cases against the engine's own test kit |

The verb lists at the top of `policy.ts` are the knobs to tune.

## Roadmap

Next: the browser up-route becomes a log tag until the comparison it rests on is made like for like; a per-agent call counter with a warning and a prompt cap for long browser runs; rate-limit aware tiers; the session tagger applied, one-way escalation only, once its shadow record says the lookup and bounded picks are safe; a step-up rule driven by the outcome stats.
