# ai-plugins

Claude Code plugins and mods. This repository is also a plugin marketplace: add it once, then install any plugin here by name.

## Install a plugin

At the prompt of a terminal session:

```
/plugin install local-router --marketplace smhnkmr/ai-plugins
```

From a shell:

```
claude plugin install local-router --marketplace smhnkmr/ai-plugins
```

Answer `y` to add the marketplace, then pick a scope. In the Desktop app, where `/plugin` does not run, click + next to the prompt box, then Plugins, Add marketplace with `smhnkmr/ai-plugins`, then Add plugin.

## Plugins

| Name | What it does |
| --- | --- |
| [local-router](mods/local-router) | Picks each subagent's model by task complexity, on your machine. Heavy work to Opus, light checks to Sonnet, read-only research to Haiku. Records what each subagent cost. No network. |
| [orchestrator](mods/orchestrator) | Makes the main model an orchestrator: four named cheap agents (scout, researcher, worker, verifier) and a system-prompt section with the economics of delegation. A switch in `/config`. No network. |

The two are independent and work together: the router respects the orchestrator's pinned agent models and routes the main model's generic spawns.

## Develop

Load a mod from the clone for one session:

```
claude --plugin-dir ./mods/local-router
```

Check and test it:

```
claude plugin validate ./mods/local-router
claude plugin test ./mods/local-router
```

An interactive session watches a `--plugin-dir` folder and reloads the mod when a file is saved.
