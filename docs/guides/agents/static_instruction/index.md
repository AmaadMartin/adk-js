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
`llmRequest.contents` instead. It lands before the last run of user content, so
the model reads it just before the turn it applies to, and the conversation
history ahead of it stays a reusable prefix. The static prefix therefore stays
identical across turns while the dynamic part still reaches the model.

Two consequences follow from that move, and both are handled for you.
`Content` has no system role, so the relocated instruction would arrive looking
like something the user said. ADK wraps it in a preamble and a marker pair that
tell the model the block is its own instruction:

```
<preamble explaining the markers>
<<<BEGIN_SYSTEM_INSTRUCTION>>>
Your interpolated instruction.
<<<END_SYSTEM_INSTRUCTION>>>
```

The instruction is state-interpolated, so session state could contain the
literal end marker and close the block early; every marker inside the text is
replaced with `<<<ELIDED_MARKER>>>` before wrapping.

Setting `staticInstruction` does not enable caching on its own. It makes the
request cacheable, and the provider decides the rest. The Live API has its own
cache mechanism, so this field does not apply there.

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

With `user_name` set to `Ada` in the session, the request carries:

- `config.systemInstruction` — `You are a document analyst.`
- the conversation history, up to the latest model turn.
- a user content holding the preamble, the begin marker, `The user is Ada.
Answer from the manual only.`, and the end marker.
- the latest user turn, last.

Other processors, such as the agent identity one, contribute their own text to
the system instruction as usual.

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

The PDF becomes the first entry in `contents`, ahead of the history, so it too
stays a stable request prefix. A request carrying such data is the one case
where the labelled dynamic instruction also leads the contents rather than
sitting at the turn boundary. Inline binary parts get the same treatment under
`inline_data_<n>` ids. One counter numbers both kinds, in document order, so a
run of inline, file, inline yields `inline_data_0`, `file_data_1`,
`inline_data_2`. A `displayName` on the part is named first in the reference
line, then the URI, then the MIME type.

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
