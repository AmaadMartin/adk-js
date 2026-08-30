# preload_memory

`PRELOAD_MEMORY` searches memory before every model call and puts what it finds
into the request contents. Reach for it when an agent should recall earlier
conversations without spending a tool call on it.

## Introduction

A session starts empty. Anything the user said in an earlier session lives in
the memory service, and something has to fetch it. `loadMemory` leaves that
decision to the model: the model calls the tool when it judges a question needs
history, which costs a round trip. `PRELOAD_MEMORY` makes the decision for the
model. It is a tool in name only — the model never calls it, and `runAsync`
throws if anything tries.

Before each request the tool takes the text of the user's message as the query,
searches memory, and inserts one user content holding a `<PAST_CONVERSATIONS>`
block. Every request pays for a search, and no request pays for a tool call.
The two tools compose: `PRELOAD_MEMORY` covers the common case, and `loadMemory`
lets the model dig for what the raw message did not surface.

The block goes into `contents`, not into the system instruction. The system
instruction stays byte-identical from turn to turn, so a provider can still
reuse its cached prefix. The tool inserts the block before the trailing run of
ordinary user contents, and after a function response, so a function call is
never separated from its response.

## Get started

`InMemoryRunner` wires an `InMemoryMemoryService` for you. This saves one
session to memory, then asks a fresh session a question that only the first
session can answer.

```ts
import {
  createEvent,
  InMemoryRunner,
  LlmAgent,
  PRELOAD_MEMORY,
} from '@google/adk';
import {createUserContent} from '@google/genai';

const APP_NAME = 'memory_demo';
const USER_ID = 'user-1';

const agent = new LlmAgent({
  name: 'memory_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer questions about the user.',
  tools: [PRELOAD_MEMORY],
});

const runner = new InMemoryRunner({agent, appName: APP_NAME});

const firstSession = await runner.sessionService.createSession({
  appName: APP_NAME,
  userId: USER_ID,
});
await runner.sessionService.appendEvent({
  session: firstSession,
  event: createEvent({
    author: 'user',
    content: createUserContent('My favorite color is green.'),
  }),
});
await runner.memoryService!.addSessionToMemory(firstSession);

const secondSession = await runner.sessionService.createSession({
  appName: APP_NAME,
  userId: USER_ID,
});
for await (const event of runner.runAsync({
  userId: USER_ID,
  sessionId: secondSession.id,
  newMessage: createUserContent('What is my favorite color?'),
})) {
  const text = event.content?.parts?.[0]?.text;
  if (text) console.log(text);
}
```

Nothing is remembered until you hand a session to the memory service, so the
`addSessionToMemory` call above is required.

## What the model sees

The tool inserts one extra user content. The rest of the history keeps its
order.

```
contents (before)                contents (after)
─────────────────────────        ─────────────────────────────────
user:  historical question       user:  historical question
model: historical answer         model: historical answer
user:  current query             user:  <PAST_CONVERSATIONS> …
                                 user:  current query
```

The inserted text carries one line per memory entry, and a `Time: <timestamp>`
line before an entry that has a timestamp:

```
The following content is from your previous conversations with the user.
They may be useful for answering the user's current query.
<PAST_CONVERSATIONS>
Time: 2026-01-01T12:00:00Z
user: My favorite color is green.
</PAST_CONVERSATIONS>
```

An entry with no author contributes its text without the `author: ` prefix.
Only the text of a memory entry is used. A part that carries inline data or a
function call contributes nothing, and an entry whose parts are all text-free
produces no line at all.

## When the tool does nothing

The request is left completely unmodified when any of these holds:

- the user's message has no text in its first part;
- the runner has no memory service;
- the search throws — the tool logs a warning and the turn continues;
- the search returns no memories, or no memory carries text.
