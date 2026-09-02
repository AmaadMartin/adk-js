# LoadMemoryTool

Lets the model search the user's long-term memory on demand. Reach for it when
an agent must answer from earlier sessions, but only sometimes, so loading the
whole memory into every prompt would waste tokens.

## Introduction

`LoadMemoryTool` publishes one function, `load_memory(query)`, to the model. The
model decides when to call it. The tool passes the query to the memory service
on the invocation context and returns the matching entries to the model as a
function response.

This is the pull half of ADK's memory story. `PreloadMemoryTool` is the push
half: it searches memory with the user's own message before each turn and
injects the result, so the model never chooses. Pick `LoadMemoryTool` when most
turns need no memory, and
`PreloadMemoryTool` when almost every turn does. Both read the same
`BaseMemoryService`, so they need the same setup and you can register either one
against an existing service.

The tool returns each `MemoryEntry` exactly as the service produced it. The
`content` stays a `Content` object with its `role` and all of its parts, so the
model sees who said what. This matches adk-python's
`src/google/adk/tools/load_memory_tool.py`.

## Get started

Register `LOAD_MEMORY` on an agent, write a session into memory, then ask a
question in a new session.

```ts
import {createEvent, InMemoryRunner, LlmAgent, LOAD_MEMORY} from '@google/adk';
import {createUserContent} from '@google/genai';

const agent = new LlmAgent({
  name: 'memory_agent',
  description: 'Answers questions from memory.',
  instruction: 'Answer questions about the user using memory.',
  model: 'gemini-2.5-flash',
  tools: [LOAD_MEMORY],
});

const runner = new InMemoryRunner({agent, appName: 'memory_app'});

// Record something worth remembering, then commit that session to memory.
const past = await runner.sessionService.createSession({
  appName: 'memory_app',
  userId: 'user_1',
});
await runner.sessionService.appendEvent({
  session: past,
  event: createEvent({
    author: 'user',
    content: createUserContent('My favorite color is green.'),
  }),
});
await runner.memoryService!.addSessionToMemory(past);

// A fresh session has no history, so the model must call load_memory.
const session = await runner.sessionService.createSession({
  appName: 'memory_app',
  userId: 'user_1',
});
for await (const event of runner.runAsync({
  userId: 'user_1',
  sessionId: session.id,
  newMessage: createUserContent('What is my favorite color?'),
})) {
  const text = event.content?.parts?.[0]?.text;
  if (text) {
    process.stdout.write(text);
  }
}
```

`InMemoryRunner` supplies an `InMemoryMemoryService`, which matches on keywords
and is meant for prototyping. Swap in another `BaseMemoryService` through
`Runner` for anything else.

## The response the model sees

A successful call resolves to a `LoadMemoryResponse`:

```ts
{
  memories: [
    {
      content: {role: 'user', parts: [{text: 'My favorite color is green.'}]},
      author: 'user',
      timestamp: '2026-01-15T10:30:00.000Z',
    },
  ],
}
```

`author` and `timestamp` are optional, and a service that does not record them
omits them. An empty `memories` array means the search found nothing; it is not
an error.

## The system instruction

`processLlmRequest` appends this instruction on every request:

> You have memory. You can use it to answer questions. If any questions need you
> to look up the memory, you should call load_memory function with a query.

It appends after any instruction already in `config.systemInstruction`, so your
own instruction stays first. The tool adds the instruction whether or not a
memory service is configured, because `BaseTool.processLlmRequest` registers the
function declaration either way.

## Failure modes

A call without a `query`, or with a `query` that is not a string, returns an
error payload instead of searching:

```ts
{
  error: 'Invoking `load_memory()` failed as the following mandatory input ' +
    'parameters are not present:\nquery\nYou could retry calling this tool, ' +
    'but it is IMPORTANT for you to provide all the mandatory parameters.',
}
```

The model reads that error and can retry with the argument. The tool does not
call the memory service on this path.

An agent that lists `LOAD_MEMORY` without a memory service throws
`Memory service is not initialized.` when the model calls the tool. Configure a
memory service on the `Runner`, or drop the tool from the agent.
