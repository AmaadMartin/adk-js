# LangGraphAgent

`LangGraphAgent` runs a compiled [LangGraph](https://langchain-ai.github.io/langgraphjs/)
state graph as an ADK agent. Reach for it when you already have a graph and you
want an ADK runner, session service and agent tree around it.

## Introduction

An ADK agent tree and a LangGraph graph are two different orchestration models.
The graph owns its own nodes, edges and optional checkpointer. ADK owns the
session, the event history and the runner. `LangGraphAgent` is the adapter
between them: it converts the ADK session's events into LangChain messages,
invokes the graph once, and yields the graph's last message as one ADK event.

You pass an already-compiled graph; the agent never compiles one. Because it is
a `BaseAgent`, it also slots under an `LlmAgent` or a `SequentialAgent` like any
other sub-agent.

## Get started

`@langchain/core` is an optional peer dependency, so install it yourself:

```sh
npm install @langchain/core @langchain/langgraph
```

```ts
import {InMemoryRunner, LangGraphAgent} from '@google/adk';
import {AIMessage} from '@langchain/core/messages';
import {END, MessagesAnnotation, START, StateGraph} from '@langchain/langgraph';

const graph = new StateGraph(MessagesAnnotation)
  .addNode('respond', (state) => ({
    messages: [new AIMessage(`echo: ${state.messages.at(-1)?.text}`)],
  }))
  .addEdge(START, 'respond')
  .addEdge('respond', END)
  .compile();

const weatherAgent = new LangGraphAgent({
  name: 'weather_agent',
  description: 'Answers weather questions.',
  instruction: 'You answer weather questions.',
  graph,
});

const runner = new InMemoryRunner({agent: weatherAgent, appName: 'weather'});
const session = await runner.sessionService.createSession({
  appName: 'weather',
  userId: 'user-1',
});

for await (const event of runner.runAsync({
  userId: 'user-1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'Is it raining?'}]},
})) {
  console.log(event.author, event.content?.parts?.[0].text);
}
```

## Which messages the graph receives

The agent chooses one of two strategies, based on whether the compiled graph
carries a checkpointer.

Without a checkpointer, the graph has no memory of its own, so the agent
replays the conversation on every run. It forwards the user's turns and this
agent's own turns, in order. Events authored by anyone else, such as a parent
agent's delegation text, are dropped.

With a checkpointer, LangGraph owns the memory. The agent forwards only the
trailing run of user messages, so the checkpointed history is not duplicated.

`instruction` is prepended as a `SystemMessage`, but only when the graph holds
no accumulated messages yet. On a checkpointed graph that means the first turn
only.

## Thread ids

The agent derives the checkpointer thread id from the session's app name, user
id and session id together. Session ids are caller-chosen and are only unique
within an (app name, user id) pair, so two users with the same session id get
two different threads.

The derivation is a SHA-256 digest of the three length-prefixed components. It
is stable across processes, and adk-python derives the same id for the same
triple. The scheme is internal, so do not depend on the exact digest.

## Limitations

Live mode is not supported. `runLive` throws.

Each run yields exactly one event, carrying the text of the graph's last
message. The graph's intermediate messages do not become ADK events.
