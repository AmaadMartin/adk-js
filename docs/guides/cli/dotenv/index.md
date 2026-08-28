# Per-agent `.env` loading

The ADK command line tools load the `.env` file that sits next to the agent
they are about to run. Reach for this when one agents directory holds several
agents and each one needs its own API key, project or model name.

## Introduction

An agent module reads `process.env` while it is imported. A model name, an API
key or a project id is therefore fixed at import time, and whatever is in the
environment at that moment decides what the agent becomes.

Without per-agent loading the CLI reads only the `.env` in the working
directory. Every agent in the directory then shares one set of values, and an
agent's own `.env` is ignored. Per-agent loading closes that gap: before the
CLI imports an agent, it searches for a `.env` starting at the agent's own
folder and walking up to the filesystem root. The first file it finds is
loaded.

Three rules decide the final value of a variable:

1. A variable you exported in your shell always wins.
2. A `.env` overrides a value that an earlier `.env` set.
3. The nearest `.env` to the agent wins, because the walk stops at the first
   hit.

Rule 1 means a `.env` can never change a value you passed in on purpose. Rule 2
means each agent gets its own file, even though all agents share one process.

## Get started

Give each agent a folder and a `.env`:

```
agents/
  .env                 GOOGLE_CLOUD_PROJECT=shared-project
  billing/
    .env               GEMINI_API_KEY=billing-key
    agent.ts
  support/
    agent.ts
```

`agents/billing/agent.ts` reads the environment as usual:

```ts
import {LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: process.env.AGENT_NAME ?? 'billing',
  model: 'gemini-2.0-flash',
  instruction: 'You are helpful.',
});
```

Run it:

```sh
adk run agents/billing/agent.ts
```

The CLI loads `agents/billing/.env` before it imports the agent. Loading
`support`, which has no `.env` of its own, walks up and loads `agents/.env`.

Add `--log_level debug` to see which file the CLI chose:

```
DEBUG: [ADK] <timestamp> Loaded .env file for agent.ts at /home/me/agents/billing/.env
```

## Which commands load a `.env`

`adk run`, `adk web`, `adk api_server` and both `adk deploy` targets. The
search always starts at the agent, so the file that is loaded depends on the
agent, not on the directory you started the command in.

## Turning it off

Set `ADK_DISABLE_LOAD_DOTENV` to `1` or `true`. The CLI then reads no `.env`
file at all:

```sh
ADK_DISABLE_LOAD_DOTENV=1 adk web agents
```

Use this in a container. The container already has its environment injected,
and a `.env` that was committed by mistake must not shadow it.

## What is not covered

The CLI also loads a `.env` from the working directory when it starts. That
happens before any agent loads, so those values count as explicit and outrank a
per-agent `.env` by rule 1. Keep shared defaults in the agents directory rather
than in the working directory if you want an agent to be able to override them.

A missing `.env` is not an error. The CLI logs `No .env file found for <agent>`
at debug level and carries on.
