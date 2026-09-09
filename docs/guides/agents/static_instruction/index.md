# Static instructions

`LlmAgent.staticInstruction` is the part of an agent's instruction that the
model receives literally, without placeholder substitution. Reach for it when
you want a byte-stable request prefix, which is what provider-side context
caching keys off.

## Introduction

An ordinary `instruction` is a template. The instructions processor resolves it
and injects session state, so `'The user is {user_name}.'` becomes
`'The user is Ada.'`. That is what makes it useful, and it is also what makes
it unsuitable for caching: the resolved text differs on every turn, so the
front of the request never repeats and a provider cache never hits.

`staticInstruction` is the other half. Its content is sent as it stands. No
state is injected, no placeholder is substituted, and nothing is trimmed. A
`{policy_id}` in a static instruction reaches the model as the six characters
plus braces.

Setting it also moves the ordinary `instruction` out of the system instruction.
Keeping both there would put changing text into the prefix you asked to keep
stable. The dynamic instruction goes into `llmRequest.contents` instead, and it
lands before the last run of user content — so the model reads it just before
the turn it applies to.

`Content` has no system role, so a dynamic instruction riding in `contents`
would otherwise read as user speech. ADK wraps it in a preamble and puts the
text between `<<<BEGIN_SYSTEM_INSTRUCTION>>>` and
`<<<END_SYSTEM_INSTRUCTION>>>`. The instruction carries interpolated session
state, which a user can reach, so any marker occurring inside the text is
replaced with `<<<ELIDED_MARKER>>>` first. State cannot close the block early
and carry on speaking outside it.

## Get started

```ts
import {InMemorySessionService, LlmAgent, Runner} from '@google/adk';
import {createUserContent} from '@google/genai';

const agent = new LlmAgent({
  name: 'support_agent',
  model: 'gemini-2.5-flash',
  // Never interpolated, so it is stable across turns.
  staticInstruction: 'You are a support agent for ACME. Be concise.',
  // Interpolated every turn, so it rides in the contents.
  instruction: 'The current user is {user_name}.',
});

const sessionService = new InMemorySessionService();
const session = await sessionService.createSession({
  appName: 'support',
  userId: 'ada',
  state: {user_name: 'Ada'},
});
const runner = new Runner({appName: 'support', agent, sessionService});

for await (const event of runner.runAsync({
  userId: 'ada',
  sessionId: session.id,
  newMessage: createUserContent('When does my refund arrive?'),
})) {
  if (event.content?.parts?.[0]?.text) {
    process.stdout.write(event.content.parts[0].text);
  }
}
```

The model receives `'You are a support agent for ACME. Be concise.'` as its
system instruction, and a labelled `'The current user is Ada.'` just before the
question.

## Accepted shapes

`staticInstruction` is a `ContentUnion`, so all of these work:

```ts
staticInstruction: 'One instruction';
staticInstruction: ['First', 'Second']; // joined with a blank line
staticInstruction: {text: 'One part'};
staticInstruction: [{text: 'First'}, {text: 'Second'}];
staticInstruction: {role: 'user', parts: [{text: 'One part'}]};
```

## Non-text parts

A system instruction is a string, so inline data and file data cannot live in
it. Each such part becomes a textual reference in the system instruction plus a
user content carrying the data:

```ts
const agent = new LlmAgent({
  name: 'handbook_agent',
  model: 'gemini-2.5-flash',
  staticInstruction: {
    role: 'user',
    parts: [
      {text: 'Answer only from the handbook below.'},
      {
        fileData: {
          fileUri: 'files/handbook',
          mimeType: 'application/pdf',
          displayName: 'handbook.pdf',
        },
      },
    ],
  },
});
```

The system instruction becomes:

```
Answer only from the handbook below.

[Reference to file data: file_data_0 ('handbook.pdf', URI: files/handbook, type: application/pdf)]
```

and `contents` gains a user content with two parts: the text
`'Referenced file data: file_data_0'` and the `fileData` part itself. Reference
ids come from one counter shared by inline and file data, so mixed parts are
numbered `inline_data_0`, `file_data_1`, `inline_data_2`.

Such content leads the request. It has to stay in the same place across turns
for the cache prefix to match, so it goes ahead of the conversation history
rather than just ahead of the latest user turn.

## What it does not do

- It does not substitute placeholders. Use `instruction` for anything that
  depends on session state.
- It does not accept a `File`. The TypeScript `ContentUnion` has no `File`
  member; pass `fileData` instead.
- It does not enable caching by itself. It makes a stable prefix possible;
  whether the provider caches it depends on the model and your cache
  configuration.
