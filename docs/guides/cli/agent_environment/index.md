# The run context of `adk run`

`adk run` builds three things before it starts a turn: the environment the
agent reads, the name its session is filed under, and the services the runner
uses. Reach for this guide when a variable in your agent's `.env` is ignored,
or when `adk run` and `adk web` disagree about what an agent is called.

## Introduction

An agent directory usually owns its configuration. `agents/weather/.env` holds
the API key and the database URL that `agents/weather/agent.ts` needs, and the
directory name is what `adk web` and `adk api_server` serve the agent under.

`adk run` follows both of those rules. It reads the `.env` nearest to the agent
file, and it names the session after the agent's directory. The load happens
before the CLI builds any service, so a `DATABASE_URL` in the file still
decides which session service the run gets.

The run also carries an `InMemoryCredentialService`. A tool that asks for a
credential stores the exchanged value there, so the next turn of the same run
finds it instead of asking again. The store lives in memory and ends with the
process.

## Get started

```
agents/
  weather/
    agent.ts
    .env
```

`agents/weather/agent.ts`:

```ts
import {LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.0-flash',
  instruction: 'Answer questions about the weather.',
});
```

`agents/weather/.env`:

```
GOOGLE_API_KEY=your-key
```

Run it from anywhere:

```bash
npx adk run ./agents/weather/agent.ts
```

The CLI reads `agents/weather/.env` even though the working directory is not
`agents/weather`, and files the session under `weather` — not under
`assistant`, the agent's own name.

## How the `.env` is found

The search starts at the agent's directory and climbs one directory at a time
to the filesystem root. The first file named `.env` wins. Both agent layouts
work: `agents/weather/agent.ts` starts the search in `agents/weather`, and
`agents/weather.ts` starts it in `agents`.

Set `ADK_DISABLE_LOAD_DOTENV` to `1` or `true` to skip the search. Use it in
continuous integration, where the runner injects every variable and reading a
checked-in file would be wrong:

```bash
ADK_DISABLE_LOAD_DOTENV=1 npx adk run ./agents/weather/agent.ts
```

## What the file can and cannot change

A variable you exported yourself always wins:

```bash
GOOGLE_API_KEY=from-shell npx adk run ./agents/weather/agent.ts
```

`GOOGLE_API_KEY` stays `from-shell`. The CLI records which variables the
process already had before it loaded any `.env`, and restores them after each
load. A `.env` can therefore add a variable, and it can override a value an
earlier `.env` set, but it cannot overwrite your shell.

A missing file, an unreadable file, or a malformed line never stops the run.
The CLI logs the path at debug or warning level and continues. It never logs a
value from the file.

## The name the session is filed under

| The agent file exports | The session `appName`                                               |
| ---------------------- | ------------------------------------------------------------------- |
| An agent               | The agent's directory name (`agents/weather/agent.ts` -> `weather`) |
| An `App`               | The name the `App` declares                                         |

`--save_session` writes beside the agent file either way, so an `App` named
differently from its folder still saves into `agents/weather/`.
