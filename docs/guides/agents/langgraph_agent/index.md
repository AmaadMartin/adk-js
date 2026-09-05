# LangGraphAgent

`LangGraphAgent` runs an already-compiled
[LangGraph](https://langchain-ai.github.io/langgraphjs/) state graph as an ADK
agent. Reach for it when a graph already encodes the behaviour you want, and you
need that behaviour inside an ADK agent tree.

## Introduction

LangGraph and ADK both orchestrate multi-step agent behaviour, so a team that
already has a graph faces a rewrite to adopt ADK. `LangGraphAgent` removes it.
The graph stays the unit of orchestration, and ADK supplies the session, the
runner, the plugins and the event stream around it.

The agent is a `BaseAgent`, so it composes like any other: give it sub-agents,
put it under a `SequentialAgent`, or hand it to a `Runner` as the root. It is
not an `LlmAgent` and holds no model, tools or instructions of its own beyond a
system instruction it forwards to the graph.

The graph is accepted structurally, so `@google/adk` does not depend on
`@langchain/langgraph`. Any object with `getState` and `invoke` is accepted,
which also lets a test drive the agent with a stub.

## Install

The LangChain message classes are an optional peer dependency, loaded on the
first run rather than at import time:

```sh
npm install @langchain/core @langchain/langgraph
```

Without `@langchain/core`, constructing the agent still works and the first run
fails with an error naming the package and the install command.

## Get started

```ts
import {LangGraphAgent, InMemorySessionService, Runner} from '@google/adk';
import {AIMessage} from '@langchain/core/messages';
import {END, MessagesAnnotation, START, StateGraph} from '@langchain/langgraph';

const builder = new StateGraph(MessagesAnnotation)
  .addNode('respond', (state) => ({
    messages: [new AIMessage(`echo: ${state.messages.at(-1)?.text}`)],
  }))
  .addEdge(START, 'respond')
  .addEdge('respond', END);

const agent = new LangGraphAgent({
  name: 'echo_agent',
  description: 'Echoes the last message back',
  instruction: 'You are an echo service.',
  graph: builder.compile(),
});

const sessionService = new InMemorySessionService();
const session = await sessionService.createSession({
  appName: 'demo',
  userId: 'user-1',
});
const runner = new Runner({appName: 'demo', agent, sessionService});

for await (const event of runner.runAsync({
  userId: 'user-1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'hello'}]},
})) {
  process.stdout.write(event.content?.parts?.[0]?.text ?? '');
}
```

## Who owns the conversation

How you compiled the graph decides which messages reach it.

**Without a checkpointer, ADK owns the memory.** The whole conversation between
the user and this agent is rebuilt from the session events and replayed on every
turn, and the system instruction leads it every time. Events authored by another
agent are dropped, because they belong to that agent's turn.

**With a checkpointer, the graph owns the memory.** Only the trailing run of
user messages is forwarded, since the graph already holds everything before it.
The system instruction is sent only while the checkpointed state is still empty,
so it is not duplicated on later turns.

Compile the same builder with a checkpointer to switch:

```ts
import {MemorySaver} from '@langchain/langgraph';

const checkpointedGraph = builder.compile({checkpointer: new MemorySaver()});
```

With a persistent checkpointer, set `LANGGRAPH_STRICT_MSGPACK=true` before you
import LangGraph and compile the graph. LangGraph's patched releases provide
schema-derived checkpoint allowlisting, but do not enable strict
deserialization by default.

## Thread ids

The agent derives the checkpointer `thread_id` from the session's app name, user
id and session id together, as a SHA-256 digest of the length-prefixed triple.
Session ids are only unique within an (app name, user id) pair, so all three
take part; the digest keeps the raw user id out of checkpointer storage. The
same triple always yields the same thread, in this process and the next, and in
adk-python for the same session.

A stored checkpoint row therefore cannot be read back to a session id directly.
Recompute the digest to find it.

## What the agent yields

One event per run, authored by the agent, carrying the text of the graph's last
message. The graph's intermediate messages are not turned into events. Live
(audio/video) mode is not supported and throws.
