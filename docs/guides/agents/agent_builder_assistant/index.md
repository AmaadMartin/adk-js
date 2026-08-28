# Agent Builder Assistant

The Agent Builder Assistant is an `LlmAgent` you chat with to design and
scaffold a new adk-js agent. It asks what you want to build, proposes an
architecture, and then writes the TypeScript files into a project directory the
chat session names. Reach for it when you want an agent authored for you inside
an existing directory, rather than writing the files yourself.

## Introduction

Writing an agent means making the same decisions every time: which agent type
fits, which model backs it, which tools it needs, and where each file goes. The
assistant runs that conversation and then commits the result to disk.

It works in one directory and only that directory. The session's
`root_directory` state key names the project root. Every path the assistant's
tools touch is resolved against that root, and a path landing outside it is
refused. This binding is what makes the assistant safe to point at a real
project: the model chooses filenames, but it cannot choose where the tree
lives.

The containment check is lexical. It compares two resolved path strings, so it
stops `../` traversal and absolute paths elsewhere. It is not a sandbox: it does
not survive symlinks, hardlinks, bind mounts, or a race between the check and
the write. Point the assistant at a directory you would let a code generator
write to.

The assistant carries three tools: `read_files`, `write_files` and
`delete_files`. `delete_files` requires user confirmation, so a deletion pauses
the run until you approve it. The assistant cannot list a directory or search
the web, so tell it which files exist when it needs to know.

## Get started

```ts
import {createAgentBuilderAssistant} from '@google/adk-devtools';
import {InMemorySessionService, Runner} from '@google/adk';

const assistant = createAgentBuilderAssistant({model: 'gemini-2.5-pro'});
const sessionService = new InMemorySessionService();

const session = await sessionService.createSession({
  appName: 'agent-builder',
  userId: 'u',
  // Binds this chat to one project. Every tool path resolves against it.
  state: {root_directory: '/home/me/projects/dice_roller'},
});

const runner = new Runner({
  appName: 'agent-builder',
  agent: assistant,
  sessionService,
});
```

Ask it to build something, and it proposes a design first:

> build me an agent that rolls an n-sided die and checks whether the result is
> prime

On approval it calls `write_files` with paths relative to the project root:

```json
{
  "files": {
    "agent.ts": "...",
    "tools/roll_die.ts": "..."
  }
}
```

Note the paths. They never carry the project folder name, because the tools
already resolve against the root. `dice_roller/agent.ts` would create
`dice_roller/dice_roller/agent.ts`.

## Configuration

`createAgentBuilderAssistant` takes one option:

```ts
createAgentBuilderAssistant({model: 'gemini-2.5-flash'});
```

`model` accepts a model id or a `BaseLlm` instance, and defaults to
`gemini-2.5-pro`. The assistant names this model in its prompt as the default
it should propose when you ask for one. It does not choose a model for the
agent it builds; it asks you.

The assistant sets `maxOutputTokens` to 8192 so one reply can carry several
complete files.

## What the assistant writes

The prompt tells the model to follow adk-js conventions, so a generated project
looks like this:

- `agent.ts` exports `rootAgent`.
- Agent classes come from `@google/adk`.
- Each function tool is one module under `tools/`, built with
  `new FunctionTool({name, description, parameters, execute})` over a zod
  schema.
- Every `LlmAgent` sets `model` explicitly. Workflow agents
  (`SequentialAgent`, `ParallelAgent`, `LoopAgent`) set none.

The model produces this code, so review it before you run it.

## Failure modes

- **A path outside the root fails the whole call.** One escaping path in a
  batch stops every file in that batch, so a partially-written project is not
  left behind. The result carries `success: false` and no per-file entries.
- **A per-file error does not stop the batch.** An unreadable file, or a write
  into a missing parent when `create_directories` is false, sets that entry's
  `error` and flips `success` to `false`. The remaining files still go through.
- **Deleting a missing file succeeds.** The result records
  `File does not exist: <path>` and still counts the deletion, because the
  caller's intent is already satisfied.
- **The tools never throw at the model.** An unexpected failure comes back in
  `errors`, so the assistant can explain it instead of ending the turn.

## Relation to adk-python

adk-python ships a larger assistant at
`src/google/adk/cli/built_in_agents/`. It builds YAML agent configurations and
carries tools for project exploration, ADK source search, and web research.
adk-js has no YAML agent runtime and no `AgentConfig` JSON Schema, so this
assistant writes TypeScript and carries only the three file tools.

The agent name, the tool names, the tool arguments, the result fields and the
8192-token cap all match adk-python, because the model sees them.
