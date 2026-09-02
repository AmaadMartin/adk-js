# Saving an agent's answer with `outputKey`

`outputKey` names a session-state key. The agent writes its answer there, so a
later agent or a template can read it. Reach for it when one agent's reply is
the input to the next step.

## Introduction

An `LlmAgent` emits events. Only the event that ends the turn carries the
answer, and the answer is the text the model addressed to the user. `outputKey`
turns that text into a session-state entry, which is how agents in a
`SequentialAgent` hand work to each other.

Four rules decide what gets written. Each one exists because the naive rule
loses data.

- **Thought parts are excluded.** A thinking model emits its reasoning as parts
  marked `thought`. That text is not the answer, so it never reaches the key.
- **Streamed segments are joined.** Under streaming with tools, the model emits
  text, calls a tool, then emits more text. The text that shares an event with
  a tool call does not end the turn, so saving only the last segment drops most
  of the reply. The agent accumulates every non-partial segment of the turn
  instead.
- **An event with no text leaves the key alone.** A tool that skips
  summarization produces a final event holding only its function response. The
  agent writes nothing, so a value an `afterToolCallback` stored survives.
- **A `task` agent writes nothing.** It reports its result through
  `finish_task`, so the conversation on the way there is not the answer.

`outputSchema` changes the shape of the value. The agent parses the text as
JSON and stores the parsed object. Accumulation is off in that case, because a
concatenation of segments is not one parseable document.

## Get started

```ts
import {InMemorySessionService, LlmAgent, Runner} from '@google/adk';

const writer = new LlmAgent({
  name: 'writer',
  model: 'gemini-2.5-flash',
  instruction: 'Write one sentence about the topic the user names.',
  outputKey: 'draft',
});

const sessionService = new InMemorySessionService();
const runner = new Runner({appName: 'demo', agent: writer, sessionService});
const session = await sessionService.createSession({
  appName: 'demo',
  userId: 'user',
});

for await (const _ of runner.runAsync({
  userId: session.userId,
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'otters'}]},
})) {
  // Drain the stream. The value lands in session state.
}

const updated = await sessionService.getSession({
  appName: 'demo',
  userId: session.userId,
  sessionId: session.id,
});
console.log(updated?.state['draft']);
```

## Chaining two agents

The second agent reads the first agent's answer through an instruction
placeholder. The placeholder name is the `outputKey` of the earlier agent.

```ts
import {LlmAgent, SequentialAgent} from '@google/adk';

const writer = new LlmAgent({
  name: 'writer',
  model: 'gemini-2.5-flash',
  instruction: 'Write one sentence about the topic the user names.',
  outputKey: 'draft',
});

const editor = new LlmAgent({
  name: 'editor',
  model: 'gemini-2.5-flash',
  instruction: 'Shorten this sentence: {draft}',
  outputKey: 'final',
});

const pipeline = new SequentialAgent({
  name: 'pipeline',
  subAgents: [writer, editor],
});
```

## A structured answer

Declare `outputSchema` and the stored value is an object rather than a string.

```ts
import {LlmAgent} from '@google/adk';
import {Type} from '@google/genai';

const grader = new LlmAgent({
  name: 'grader',
  model: 'gemini-2.5-flash',
  instruction: 'Score the answer from 0 to 1 and explain the score.',
  outputKey: 'grade',
  outputSchema: {
    type: Type.OBJECT,
    properties: {
      score: {type: Type.NUMBER},
      reason: {type: Type.STRING},
    },
  },
});
```

The agent writes nothing when the final chunk is blank, so an empty trailing
chunk of a stream cannot fail the parse.

## A cached answer

`beforeAgentCallback` can answer without calling the model. The agent saves
that answer under `outputKey` too, so a cache hit and a model reply leave the
same session state behind.

```ts
import {LlmAgent} from '@google/adk';

const cached = new LlmAgent({
  name: 'cached',
  model: 'gemini-2.5-flash',
  outputKey: 'result',
  beforeAgentCallback: () => ({
    role: 'model',
    parts: [{text: 'cached answer'}],
  }),
});
```

## Which agent may write the key

Only the agent that owns `outputKey` writes it, and only for events it authored
itself. After a transfer the sub-agent's reply belongs to the sub-agent, so the
parent's key keeps the text the parent produced.
