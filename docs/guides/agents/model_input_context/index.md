# Model input context

`RunConfig.modelInputContext` adds contents to one invocation's LLM request
without writing them to the session. Reach for it when the model needs
per-turn material — retrieved documents, a rendered form, the current page a
user is looking at — that should not become part of the conversation history.

## Introduction

Everything an agent normally sends to the model comes from session events. The
content request processor reads the event history and turns it into
`llmRequest.contents`, so anything you want the model to see has to be an event
first. That is the right default: it is how a later turn still knows what
happened.

It is the wrong default for material that is only true right now. A retrieved
document that answers this question is noise in the next question, and a
rendered page is stale as soon as the user navigates. Appending it to the
session makes it permanent, and it is then carried on every later request until
compaction removes it.

`modelInputContext` is the escape hatch. The runner never persists it. The
content request processor inserts a deep copy of it into `llmRequest.contents`
immediately before the invocation's user content, so the model reads the
context and then the question it answers.

Two neighbouring pieces do related things. Session state (`ctx.state`) carries
values between turns, and a `temp:` key is dropped before storage — but state
is text substituted into instructions, not contents. Memory services recall
whole past sessions. `modelInputContext` sits between them: real `Content`
objects, this invocation only.

## Get started

```ts
import {InMemorySessionService, LlmAgent, Runner} from '@google/adk';
import {createUserContent} from '@google/genai';

const agent = new LlmAgent({
  name: 'support_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer using the context you are given.',
});

const sessionService = new InMemorySessionService();
const runner = new Runner({
  appName: 'support',
  agent,
  sessionService,
});

const session = await sessionService.createSession({
  appName: 'support',
  userId: 'ada',
});

for await (const event of runner.runAsync({
  userId: 'ada',
  sessionId: session.id,
  newMessage: createUserContent('When does my refund arrive?'),
  runConfig: {
    modelInputContext: [
      createUserContent('Refund policy: refunds settle in 5 business days.'),
    ],
  },
})) {
  if (event.content?.parts?.[0]?.text) {
    process.stdout.write(event.content.parts[0].text);
  }
}
```

The model sees the refund policy and then the question. The session holds only
the question and the answer.

## Where the block lands

The processor looks for the invocation's user content in the assembled
contents and inserts the block directly before it. The rule holds through a
tool call: the request then ends with the function call and its response, and
the block still precedes the user message that started the turn.

When the user content is not in the contents at all, the block goes to the
front. That happens when the invocation carries no user content, and for a
sub-agent whose turn starts from another agent's message: the processor
relabels that message as context, so it no longer equals the user content.

## What it does not do

- It is not persisted. Nothing writes it to the session, so a later
  invocation does not see it. Pass it again on every call that needs it.
- It is not deduplicated. Two identical blocks on two turns are two
  independent per-turn insertions, not one shared prefix.
- An empty array is a no-op.
