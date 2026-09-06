# AntigravityAgent

Runs a Google Antigravity agent as a native ADK agent node.

## Introduction

`AntigravityAgent` puts an Antigravity agent into an ADK application as an
ordinary `BaseAgent`. Each ADK turn is delegated to the Antigravity harness, and
its trajectory steps — model text, tool calls, tool responses — come back as ADK
events recorded in the session. Reach for it when you want the Antigravity
harness's local workspace tooling and policies, and ADK's orchestration,
sessions and UI around it.

The harness owns its own loop and its own conversation. That is the one thing
that shapes the rest of this guide: an `AntigravityAgent` must be an ADK root
agent unless it sets `mode: 'single_turn'`, and continuity between turns comes
from a conversation id in ADK session state rather than from anything held open.

### There is no Antigravity SDK for JavaScript

The Antigravity SDK is a Python library. No `@google/antigravity` package is
published on npm, so `@google/adk` cannot depend on one and does not.

Instead `@google/adk` exports the shape it drives — `SdkAgent`,
`SdkConversation`, `AntigravityStep`, `AntigravityAgentConfig` and the rest — as
plain TypeScript interfaces, and you supply an `agentFactory` returning any
object with those members. Anything structurally compatible works, so you can
drive a client of your own, or a fake in a test, with no adapter layer between.

This is the one place the TypeScript API departs from adk-python, where
`config` defaults to `google.antigravity.Agent`. Here `agentFactory` is
**required**, because there is no class to default to.

## Get started

```ts
import {AntigravityAgent} from '@google/adk';

export const rootAgent = new AntigravityAgent({
  name: 'antigravity_assistant',
  description: 'Runs an Antigravity agent inside ADK.',
  antigravityConfig: {
    connection: 'local',
    saveDir: './trajectories',
  },
  agentFactory: (config) => new AntigravityClient(config),
});
```

`AntigravityClient` stands for your own client. It has to satisfy `SdkAgent`:

```ts
import {AntigravityStep, SdkAgent, SdkConversation} from '@google/adk';

interface SdkAgent {
  readonly conversation: SdkConversation;
  readonly conversationId?: string;
  connect(): Promise<SdkAgent>;
  close(error?: unknown): Promise<void>;
}

interface SdkConversation {
  readonly history: readonly AntigravityStep[];
  send(prompt: string): Promise<void>;
  receiveSteps(): AsyncIterable<AntigravityStep>;
}
```

`connect` and `close` stand in for Python's `__aenter__` and `__aexit__`. The
agent closes exactly one connection per turn, including when `connect` itself
fails, so a failed connect cannot orphan a harness subprocess.

For a complete runnable example with an in-file stand-in client, see
[`samples/labs/antigravity/agent.ts`](../../../../samples/labs/antigravity/agent.ts).

## How a turn runs

Every turn builds a fresh Antigravity agent and connects it. The agent reads the
conversation id an earlier turn stored, asks to resume it, sends the user's
prompt, and converts each streamed step into ADK events. Nothing is held open
between turns.

Continuity comes from the conversation id, which the agent writes into ADK
session state under `_antigravity_conversation_id_<agentName>`. The key is
scoped by agent name, so two `AntigravityAgent`s in one session do not resume
each other's conversation.

Persisting the id needs the ADK `Runner`: the id travels on a yielded event's
`actions.stateDelta`, and the `Runner` is what applies it. An id is recorded
only when it has changed and is non-empty.

## Configuration

| Option              | Type                         | Default     | Description                                         |
| :------------------ | :--------------------------- | :---------- | :-------------------------------------------------- |
| `antigravityConfig` | `AntigravityAgentConfig`     | (required)  | The configuration describing the Antigravity agent. |
| `agentFactory`      | `(config) => SdkAgent`       | (required)  | Builds the Antigravity agent each turn runs on.     |
| `mode`              | `'single_turn' \| undefined` | `undefined` | Composition mode when this agent has an ADK parent. |

It is named `antigravityConfig`, not `config`, because `BaseAgent` already owns
a property called `config`.

`AntigravityAgentConfig` declares only the fields the agent reads or writes:
`connection`, `tools`, `hooks`, `conversationId`, `sessionContinuationMode` and
`saveDir`. Extend it with whatever else your client needs — system
instructions, workspaces, policies. Those extra fields are carried through
untouched: each turn copies the configuration and appends to `tools` and
`hooks`, and changes nothing else.

### `saveDir`, and the one setup that loses history silently

A local configuration with no `saveDir` mints a fresh temporary directory per
connection. Every turn then writes somewhere the next turn will not look, and
the conversation from the previous turn is not there to resume — with no error
of its own. The agent logs a warning at construction for exactly this case.

Set `saveDir` to a stable path, or set `mode: 'single_turn'` if independent
turns are what you want.

### `connection`

`connection: 'local'` marks a configuration that runs the harness as a local
subprocess. adk-python answers this question with
`isinstance(config, BaseLocalAgentConfig)`; there is no config class here, so
`isLocalAntigravityConfig` reads the discriminator instead. Two behaviours
depend on it: the `saveDir` warning above, and the silent-drop check below.

## ADK sub-agents become client tools

An `AntigravityAgent` can have ADK `subAgents`. The harness runs its loop over
plain tools, not ADK nodes, so each child is bridged onto the configuration as a
client-side tool named after the child.

```ts
const reviewer = new LlmAgent({
  name: 'naming_reviewer',
  description: 'Reviews variable names in a diff.',
  model: 'gemini-2.5-flash',
});

export const rootAgent = new AntigravityAgent({
  name: 'antigravity_coder',
  antigravityConfig: {connection: 'local', saveDir: './trajectories'},
  agentFactory: (config) => new AntigravityClient(config),
  subAgents: [reviewer],
});
```

Every child needs a non-empty `description`: it is the only thing the
Antigravity model reads when deciding whether to call the tool. Every child also
needs a name unique among its siblings and distinct from any tool already on
`antigravityConfig.tools`, because children join that same list and the harness
registers one tool per name. All three rules are checked at construction, and
again when the configuration is built, since `subAgents` can be mutated
afterwards.

Each call runs the child in isolation — its own `Runner` and an in-memory
session — and answers with the child's last user-visible text. A child that
emits no text answers with its last error message, and failing that with `''`;
it is never `undefined`, which would put `{"result": null}` in front of the
model. Unlike ADK's own `AgentTool`, an error the child throws propagates to the
caller rather than being reported as a string.

A client tool's result never reaches the trajectory. It arrives on the
post-tool-call hook, which the agent registers only when there are sub-agents,
because the hook costs a blocking round trip per successful call.

## Streaming

Partial events are emitted only when `runConfig.streamingMode` is
`StreamingMode.SSE`. In that mode a step's `thinkingDelta` becomes a partial
event with a `thought` part, followed by `contentDelta` as a partial text event.

Final model text is emitted once per completed response, when the step is
`isCompleteResponse` with non-empty `content`. The harness re-broadcasts the
cumulative content on every step transition, so emitting per transition would
record the same message many times.

## As a workflow node

An `AntigravityAgent` can be dropped into a workflow graph. The node input
becomes the turn's prompt, and the node output is the last model text the turn
produced, or `''` when it produced none.

## Failure modes

**A resume the harness dropped.** The local backend creates a fresh
conversation when the stored one is missing and reports success, so an empty
history after a resume is the only signal there is. When that happens the agent
clears the stored id and then throws, so the next turn starts a new conversation
instead of failing the same way forever. The check is gated on the local
connection: a remote backend that quietly does the same cannot be told apart,
and an ungated check would fail every remote resume.

**A harness error mid-turn.** The conversation is still resumable, so the agent
persists the conversation id before re-throwing. Without that the next turn
would orphan it.

**A client tool that failed.** The failure arrives on the on-tool-error hook,
never on the post-tool-call hook, and becomes a function response carrying
`{error: <message>}`. The hook is an observer and answers `undefined`, which is
what leaves the harness's own message in front of the model.

**A result with no call id.** It is dropped with a debug log. The id is the only
thing tying a result to an emitted call, so keeping one without an id risks
answering an unrelated call.

## Limitations

- **Live runs.** `runLive` is refused: the harness drives a text trajectory.
- **Nesting.** An `AntigravityAgent` must be an ADK root agent unless it sets
  `mode: 'single_turn'`. This applies to the agent's own parent, not to its
  children — its `subAgents` are bridged as client tools and never need a mode.
  Unlike adk-python, an adk-js `LlmAgent` does not expose a `single_turn` child
  as an inline tool automatically.
- **`SYSTEM_MESSAGE` steps are dropped**, matching adk-python, which carries the
  same open item.
- **Concurrency.** Running two turns of one ADK session at the same time is
  undefined: both would open the same stored conversation.
- **Sub-agent root resolution.** For an ADK child of an `AntigravityAgent`, the
  root agent is still the outermost ADK agent. Keep those children leaf-like, or
  set `disallowTransferToParent` and `disallowTransferToPeers` on them.
