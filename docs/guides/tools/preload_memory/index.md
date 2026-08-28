# preload_memory

`PRELOAD_MEMORY` searches the memory service before every model request and
hands the results to the model as conversational context. Reach for it when the
agent should always see what the user said in earlier sessions, without paying
for a tool-call round trip.

## Introduction

An agent with a memory service can recall past conversations in two ways.
`LOAD_MEMORY` is model-driven: the model calls it with a query when it decides
the answer needs history, which costs one extra round trip. `PRELOAD_MEMORY` is
automatic: the model never calls it, and it never appears in the tool list.
Before each request it searches memory with the user's message as the query.

The recalled text goes into `llmRequest.contents` as a `user` content, wrapped
in a `<PAST_CONVERSATIONS>` block. It does not go into
`config.systemInstruction`. That placement matters. The system instruction is a
stable prefix: providers key context caching on it, and every request processor
that writes there assumes the value repeats turn to turn. Recalled memory
changes with every query, so putting it in the prefix would defeat caching and
would present past conversation to the model as an authored instruction.

The two tools compose. `PRELOAD_MEMORY` covers the common case, and
`LOAD_MEMORY` lets the model dig for what the raw user message did not surface.

## Get started

The agent below records one session into memory, then answers from it in a
fresh session. `InMemoryRunner` wires an `InMemoryMemoryService` for you.

```typescript
import {
  createEvent,
  getLogger,
  InMemoryRunner,
  LlmAgent,
  PRELOAD_MEMORY,
} from '@google/adk';
import {createUserContent} from '@google/genai';

const logger = getLogger();
const APP_NAME = 'memory_demo';
const USER_ID = 'user-1';

const agent = new LlmAgent({
  name: 'memory_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer the user from the recalled conversation.',
  tools: [PRELOAD_MEMORY],
});

const runner = new InMemoryRunner({agent, appName: APP_NAME});

const past = await runner.sessionService.createSession({
  appName: APP_NAME,
  userId: USER_ID,
});
await runner.sessionService.appendEvent({
  session: past,
  event: createEvent({
    author: 'user',
    content: createUserContent('My favorite color is green.'),
  }),
});
await runner.memoryService!.addSessionToMemory(past);

const session = await runner.sessionService.createSession({
  appName: APP_NAME,
  userId: USER_ID,
});

for await (const event of runner.runAsync({
  userId: USER_ID,
  sessionId: session.id,
  newMessage: createUserContent('What is my favorite color?'),
})) {
  const text = event.content?.parts?.[0]?.text;
  if (event.author === agent.name && text) logger.debug(text);
}
```

Nothing reaches memory on its own. A session is recalled only after someone
calls `addSessionToMemory`.

## Where the recalled memory lands

The tool inserts one `user` content at the current-turn boundary. The boundary
sits before the trailing run of ordinary user contents, so the recalled block
reads as context that precedes the current question.

```
[user: historical question, model: historical answer, user: current query]
                       becomes
[user: historical question, model: historical answer, user: <PAST_CONVERSATIONS>…, user: current query]
```

One case moves the boundary. When the last user content carries a
`functionResponse`, the model is mid tool-call turn, and the block goes _after_
that content. A function call and the response that answers it must stay
adjacent.

`config.systemInstruction` is byte-identical before and after the tool runs.

## What the block contains

Each memory contributes up to two lines: `Time: <timestamp>` when the entry has
one, then `<author>: <text>` (or the bare text when the entry has no author).
The lines are joined with newlines inside the `<PAST_CONVERSATIONS>` block.

Only text parts are read. A part carrying a function call or inline data is
dropped, so it adds no separator. A memory whose parts hold no text at all
contributes no line, and when that leaves no lines the tool inserts nothing.

## Failure modes

The tool never throws and never blocks a turn.

- **No memory service.** The tool returns immediately and the request is
  untouched.
- **The search fails.** The tool logs one warning,
  `Failed to preload memory for query: <query>`, and leaves the request
  untouched.
- **The search returns nothing.** No content is inserted.
- **The user message has no text.** The tool returns before searching, so a
  turn that carries only audio or an image performs no search.

Every request pays for one memory search. That is the cost of skipping the
tool-call round trip.
