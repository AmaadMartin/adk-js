# Agent directory layouts

`AgentLoader` turns a directory of agent folders into the app list that
`adk web`, `adk api_server` and `adk deploy` serve. This guide describes the
folder and file layouts it accepts, and the export shapes it looks for inside
an entrypoint.

## Introduction

You point the CLI at one agents directory and every agent inside it becomes an
app. The loader decides two things for each entry: which file to load, and
which export in that file is the root.

An entry is either a single file or a folder. A folder can name its entrypoint
in four ways, and the loader tries them in a fixed order. `app` and `agent`
come first, because agents written before directory packages existed rely on
them. Then comes the `main` field of a `package.json`, and last `index`. That
puts `main` ahead of `index`, which is the order Node itself resolves a
directory in.

The order also decides nothing on its own. A candidate that exports no agent is
treated as a helper module that happens to carry an entrypoint name, so the
loader moves on to the next candidate. Only a candidate that throws a real
error stops the search, and that folder is then reported as a load failure
rather than skipped in silence.

One broken folder never hides the others. Each folder is loaded on its own, and
a failure is recorded against that folder alone.

## Get started

Give each agent a folder with an `index.ts` that exports `rootAgent`.

```
agents/
  weather/
    index.ts
```

```ts
// agents/weather/index.ts
import {LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'weather',
  model: 'gemini-flash-latest',
});
```

```
npx adk api_server agents
curl -s localhost:8000/list-apps
# ["weather"]
```

## Directory layouts

The loader accepts these entrypoints inside `agents/<name>/`, in this order:

| Entrypoint            | Notes                            |
| --------------------- | -------------------------------- |
| `app.<ext>`           | Preferred. Exports an `App`.     |
| `agent.<ext>`         | Exports a root agent.            |
| `package.json` `main` | The file the `main` field names. |
| `index.<ext>`         | Node's directory entrypoint.     |

`<ext>` is one of `.js`, `.cjs`, `.mjs`, `.ts`, `.mts`, `.cts`.

A single file also works: `agents/<name>.<ext>` becomes an app called
`<name>`.

The loader does not descend below the first level, so
`agents/a/b/agent.ts` stays undiscovered. It also skips `node_modules` and any
folder whose name starts with a dot.

### package.json main

A folder that is already an npm package can point at its own entrypoint.

```
agents/
  finance/
    package.json
    finance_agent.ts
```

```json
{"name": "finance", "version": "1.0.0", "main": "finance_agent.ts"}
```

```ts
// agents/finance/finance_agent.ts
import {LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'finance',
  model: 'gemini-flash-latest',
});
```

A `main` without an extension is probed against each supported extension, in
the order `.js`, `.cjs`, `.mjs`, `.ts`, `.mts`, `.cts`.

Only `main` is read. The `exports` map is not consulted, and a `main` naming a
subdirectory is not expanded to `<dir>/index.js`.

The loader ignores a `main` that resolves outside its own folder. This is a
lexical path check, not a sandbox: it does not survive symlinks.

## Export shapes

The loader takes the first of these it finds in the entrypoint:

1. `app`, then `rootApp`, then a default export, then any exported `App`.
2. `rootAgent`, then `agent.rootAgent`, then a default export, then any
   exported root agent.

An `App` therefore always wins over a bare agent in the same file. When a file
exports more than one `App`, or more than one agent, the loader uses the first
and warns.

`agent.rootAgent` covers a barrel file that republishes the agent one level
down:

```ts
// agents/legacy/index.ts
export * as agent from './agent_impl.js';
```

```ts
// agents/legacy/agent_impl.ts
import {LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'legacy',
  model: 'gemini-flash-latest',
});
```

A `rootAgent` exported directly by the entrypoint still wins over a nested one.

## Failure modes

| What happens                                                  | What you see                                             |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| No candidate exports an agent                                 | The folder is absent from `listAgents()`.                |
| A candidate throws while loading                              | The folder is absent, and `listLoadFailures()` names it. |
| `package.json` is missing, invalid, or has an unusable `main` | The manifest is ignored and `index` is tried.            |

A folder that holds only helper modules is not an error, so a `utils` folder
beside your agents stays invisible rather than filling the log.
