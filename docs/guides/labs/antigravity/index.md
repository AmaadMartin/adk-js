# AntigravityAgent

Runs a Google Antigravity agent as a native ADK agent node.

## Introduction

`AntigravityAgent` puts an Antigravity agent into an ADK application as an
ordinary `BaseAgent`. Each ADK turn is delegated to the Antigravity harness, and
the harness's trajectory steps — model text, tool calls, tool responses — come
back as standard ADK events recorded in the session. Reach for it when you want
the Antigravity harness's local workspace tooling and policies, and ADK's
orchestration, sessions and UI around it.

`@google/adk` takes **no dependency** on an Antigravity SDK. No such package is
published for JavaScript, so this module describes the SDK structurally: you
supply an `agentFactory` that returns any object matching the `SdkAgent`
interface, exactly as `CrewaiTool` and `LangchainTool` describe their frameworks
in adk-python. The port therefore works against whatever client you have,
including one you write yourself.

## Get started

```ts
import {AntigravityAgent, InMemorySessionService, Runner} from '@google/adk';

const coder = new AntigravityAgent({
  name: 'coder',
  description: 'Runs an Antigravity agent inside ADK.',
  antigravityConfig: {
    connection: 'local',
    // Stable, or every turn writes to a fresh temporary directory.
    saveDir: '/var/lib/my-app/antigravity',
  },
  agentFactory: (config) => myAntigravityClient(config),
});

const runner = new Runner({
  appName: 'app',
  agent: coder,
  sessionService: new InMemorySessionService(),
});
```

`agentFactory` is called once per ADK turn with a fresh copy of
`antigravityConfig`. It must return an object with a `conversation`, a
`connect()` and a `close()`; see `SdkAgent` and `SdkConversation` in
`core/src/labs/antigravity/sdk_types.ts` for the full shape, and
`samples/labs/antigravity/agent.ts` for a working stand-in.

## Composition modes

An `AntigravityAgent` owns a whole Antigravity conversation, so it must be an
ADK **root** agent unless it sets `mode: 'single_turn'`. Adopting one without
that mode throws at construction.

```ts
const coder = new AntigravityAgent({
  name: 'coder',
  description: 'Writes code.',
  mode: 'single_turn',
  antigravityConfig: {connection: 'local'},
  agentFactory,
});
const triager = new LlmAgent({
  name: 'triager',
  model: 'gemini-2.5-flash',
  subAgents: [coder],
});
```

Under `mode: 'single_turn'` the parent composes a self-contained request, no
session history is forwarded, and each call is an independent conversation. No
conversation id is stored or read.

`mode` cannot be reassigned after construction: the adoption guard reads it
once.

## Conversation continuity

As a root agent, `AntigravityAgent` resumes the conversation the previous turn
created. Nothing is held open between turns; the Antigravity agent is closed on
the way out and the next turn connects again. Continuity comes from the
conversation id, which the agent records in ADK session state under
`_antigravity_conversation_id_<agentName>`. The key carries the agent name, so
two `AntigravityAgent`s in one ADK session never resume each other's
conversation.

Persisting the id needs the ADK `Runner`, which is what applies a yielded
event's `stateDelta`.

A resume asks the harness for `sessionContinuationMode: 'create_or_resume'`,
the only mode that survives a store that is no longer there. For a **local**
connection, a resume that comes back with an empty history means the harness
quietly started a new conversation: the agent clears the stored id and fails the
turn, rather than letting the earlier turns be orphaned silently. The check is
gated to the local connection, because a remote backend that does the same
cannot be told apart without SDK support.

## `saveDir`

A local configuration with no `saveDir` mints a fresh temporary directory per
connection, so every turn writes somewhere the next turn will not look. The
agent logs one warning at construction when it sees that, unless
`mode: 'single_turn'` says independent turns are what you want. Set `saveDir` to
a stable path for a multi-turn conversation.

## ADK sub-agents

An `AntigravityAgent` may have ADK `subAgents`. Each child is bridged onto the
Antigravity configuration as a client-side tool named after the child, which is
the only way the harness can reach one. A child runs in isolation — its own
`Runner` and an in-memory session — and answers with its last user-visible text.

```ts
const coder = new AntigravityAgent({
  name: 'coder',
  antigravityConfig: {connection: 'local', saveDir: '/var/lib/my-app/ag'},
  agentFactory,
  subAgents: [reviewer],
});
```

Every child needs a non-empty `description`: it is the only thing the
Antigravity model reads when deciding whether to call it. Two children sharing a
name, or a child whose name collides with a tool already on the configuration,
are rejected at construction — the harness registers one tool per name and
rejects the second with an error naming only the tool.

Unlike ADK's `AgentTool`, a child that throws propagates its error to the
harness rather than reporting it as a string.

## What the agent does to your configuration

Each turn copies `antigravityConfig` and appends to the copy; your object is
never mutated. Only `tools`, `hooks`, `conversationId` and
`sessionContinuationMode` are touched. Policies, capabilities and workspaces are
passed through untouched, and there is no option that relaxes them — a local
Antigravity configuration defaults its policies to confirming a command before
it runs on the host.

Two hooks are registered, and only when there are sub-agents: a client tool's
result never reaches the trajectory, so it is captured on the tool hooks and
paired with its call afterwards. Without sub-agents no hook is registered, which
avoids a blocking round trip per successful tool call.

## Limitations

- **Live runs.** `runLive` throws. The harness drives a text trajectory.
- **Concurrency.** Running two turns of one ADK session at the same time is
  undefined; both would open the same stored conversation.
- **`SYSTEM_MESSAGE` steps** are dropped, matching adk-python.
- **Sub-agent root resolution.** For ADK children of an `AntigravityAgent`, the
  root agent is still the outermost ADK agent. Keep those children leaf-like, or
  set `disallowTransferToParent` and `disallowTransferToPeers` on them.
