# Static instructions

`LlmAgent.staticInstruction` holds the part of an agent's prompt that never
changes. ADK sends it verbatim at the start of the system instruction, and it
moves the ordinary `instruction` into the request contents. Reach for it when a
large fixed preamble, or a referenced document, should be the same bytes on
every request.

## Introduction

`instruction` is interpolated on every turn: `{user_name}` and
`{artifact.report}` are replaced from the session before the request goes out.
That makes the system instruction different on each turn, and a provider can
only cache a prefix it recognises byte for byte.

`staticInstruction` solves that. It is never interpolated. A `{placeholder}`
inside it reaches the model literally, so the agent's fixed preamble stays a
stable prefix while the session state moves.

Two consequences follow.

The dynamic `instruction` can no longer share the system instruction, because
it would change the prefix. ADK appends it to `llmRequest.contents` instead.
`Content` has no system role, so the routed instruction would otherwise look
like something the user said. ADK wraps it in a labelled block:

```
<preamble explaining the markers>
<<<BEGIN_SYSTEM_INSTRUCTION>>>
Your interpolated instruction.
<<<END_SYSTEM_INSTRUCTION>>>
```

Any marker string already inside the instruction is replaced with
`<<<ELIDED_MARKER>>>`, so interpolated state cannot close the block early and
address the model as the user.

The second consequence is about binary parts. The model API accepts only a
string system instruction, so an `inlineData` or `fileData` part cannot go
there. ADK writes a reference line into the system instruction and puts the
data itself in a user content ahead of the conversation.

Setting `staticInstruction` does not enable caching on its own. It makes the
request cacheable; the provider decides the rest. The Live API has its own
cache and does not use this field.

## Get started

```ts
import {LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'doc_agent',
  model: 'gemini-2.5-flash',
  staticInstruction: 'You are a contract analyst.',
  instruction: 'The current matter is {matter_id}.',
});
```

With `matter_id` set to `M-42` in the session, the request carries:

- `config.systemInstruction` — `You are a contract analyst.`
- `contents[0]` — a user content holding the preamble, the begin marker,
  `The current matter is M-42.`, and the end marker.
- `contents[1..]` — the conversation history.

## Referencing a document

A static instruction accepts anything genai's `ContentUnion` accepts: a string,
a `Part`, an array of either, or a whole `Content`.

```ts
const agent = new LlmAgent({
  name: 'doc_agent',
  model: 'gemini-2.5-flash',
  staticInstruction: {
    role: 'user',
    parts: [
      {text: 'You are a contract analyst.'},
      {
        fileData: {
          fileUri: 'gs://bucket/contract.pdf',
          mimeType: 'application/pdf',
        },
      },
    ],
  },
});
```

The system instruction becomes:

```
You are a contract analyst.

[Reference to file data: file_data_0 (URI: gs://bucket/contract.pdf, type: application/pdf)]
```

and `contents[0]` is a user content with the text
`Referenced file data: file_data_0` followed by the `fileData` part.

Reference ids come from one counter shared by both kinds of part, so a run of
inline, file, inline yields `inline_data_0`, `file_data_1`, `inline_data_2`. A
`displayName` on the part is named first in the reference line, then the URI,
then the MIME type.

## Guarantees

- The static instruction is never interpolated. Only `instruction` and
  `globalInstruction` read session state.
- The static content stays a request prefix. It precedes the labelled dynamic
  instruction, which precedes the conversation history.
- The dynamic instruction is never in both places. With `staticInstruction`
  set, `config.systemInstruction` does not contain it.
- The fence cannot be forged. The labelled text always ends with the end
  marker, whatever the interpolated state contained.
