# Static instructions

`LlmAgent.staticInstruction` is the part of an agent's prompt that never
changes. ADK sends it verbatim as the system instruction, ahead of everything
else, so the start of every request stays byte-identical and a provider can
cache it.

## Introduction

`instruction` is interpolated on every turn: `{user_name}` becomes the current
session value, so the system instruction differs from one request to the next.
That is what you want for a per-turn directive, and it is exactly what defeats
provider-side context caching, which keys on a stable request prefix.

`staticInstruction` splits the prompt in two. Its content is sent literally —
no placeholder substitution, no session state — so it is safe to cache. When
you set it, `instruction` stops going to the system instruction and moves into
`llmRequest.contents` instead, after the static content and before the
conversation history. The static prefix therefore stays identical across turns
while the dynamic part still reaches the model.

Two consequences follow from that move, and both are handled for you.
`Content` has no system role, so the relocated instruction would arrive looking
like something the user said. ADK wraps it in a preamble and a marker pair that
tell the model the block is its own instruction. The instruction is
state-interpolated, so session state could contain the literal end marker and
close the block early; every marker inside the text is replaced with
`<<<ELIDED_MARKER>>>` before wrapping.

The Live API has its own cache mechanism, so this field does not apply there.

## Get started

```ts
import {LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'doc_agent',
  model: 'gemini-2.5-flash',
  // Never changes. Sent verbatim: {placeholders} are NOT interpolated.
  staticInstruction: 'You are a document analyst.',
  // Changes per turn. Carries session state.
  instruction: 'The user is {user_name}. Answer from the manual only.',
});
```

The request the agent builds carries `You are a document analyst.` in its
system instruction, and the interpolated dynamic instruction as a labelled
user content ahead of the history. Other processors, such as the agent
identity one, contribute their own text to the system instruction as usual.

## Non-text content

`staticInstruction` accepts a string, a `Part`, a `Content`, or an array of
either. The model API only accepts text as a system instruction, so a part
that is not text cannot go there.

ADK puts a textual reference in the system instruction and moves the part
itself into the request contents as user content:

```ts
const agent = new LlmAgent({
  name: 'doc_agent',
  model: 'gemini-2.5-flash',
  staticInstruction: [
    'You are a document analyst.',
    {
      fileData: {
        fileUri: 'gs://bucket/manual.pdf',
        mimeType: 'application/pdf',
      },
    },
  ],
  instruction: 'The user is {user_name}. Answer from the manual only.',
});
```

The static instruction contributes this text to the system instruction:

```
You are a document analyst.

[Reference to file data: file_data_0 (URI: gs://bucket/manual.pdf, type: application/pdf)]
```

The PDF becomes the first entry in `contents`, so it too stays a stable
request prefix. Inline binary parts get the same treatment under
`inline_data_<n>` ids. One counter numbers both kinds, in document order.

## What it guarantees

- The static text is sent exactly as written. A `{placeholder}` in it reaches
  the model literally, even when session state has a matching key.
- The dynamic instruction appears in one place only. With a static
  instruction it is in `contents`; without one it is in the system
  instruction, as before.
- The labelled block ends where its framing says. Text between the markers
  contains no marker of its own.

## When not to use it

Skip it when the whole prompt is dynamic, or when it is short enough that
caching buys nothing. A static instruction adds a second place to look for
prompt text, and the `contents` your agent sends grow by one entry per turn.
