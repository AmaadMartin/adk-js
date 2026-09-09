# content_utils

`content_utils` holds the shared helpers that read and reshape a genai
`Content`. Each function's own rules are documented on it in
`core/src/utils/content_utils.ts`; this guide covers what the signatures cannot
say.

## Introduction

Three ADK subsystems ask the same questions of a `Content`, and each used to
answer them on its own. A live connection asks "which parts may I replay?". A
workflow node asks "what is the text of this model turn?". A plugin asks "how do
I mark a part the model never produced?". Answering these in each caller let the
answers drift: one text extractor kept the model's reasoning and another dropped
it, so the same content produced different text depending on who read it.

Two of the module's rules decide what the model sees, so they are worth knowing
even if you never import it:

- A **thought part is not text.** `extractTextFromContent` skips a part with
  `thought: true`, so the model's reasoning never reaches a node output or a
  tool's arguments.
- **Audio is not replayed.** ADK strips audio parts from the history it replays
  to a live session. The audio is already transcribed in that same history, and
  resending it makes the model answer twice.

The module is internal. It is not exported from `@google/adk`, and it mirrors
`google/adk-python` `utils/content_utils.py` symbol for symbol, so the two SDKs
agree on what these words mean.

## Get started

```ts
import {
  extractTextFromContent,
  filterAudioParts,
  toUserContent,
} from '../utils/content_utils.js';

// The answer, without the reasoning that produced it.
extractTextFromContent({
  role: 'model',
  parts: [{text: 'the user wants a city', thought: true}, {text: 'Amsterdam'}],
}); // 'Amsterdam'

// An arbitrary value as a user turn.
toUserContent({city: 'Amsterdam'});
// {role: 'user', parts: [{text: '{"city":"Amsterdam"}'}]}

// Drop audio before replaying a turn.
filterAudioParts({
  role: 'user',
  parts: [{text: 'hi'}, {inlineData: {mimeType: 'audio/pcm', data: 'AAE='}}],
}); // {role: 'user', parts: [{text: 'hi'}]}
```

## Divergence from adk-python

`toUserContent(null)` produces the text `'null'`, where Python's `str(None)`
produces `'None'`. JavaScript has no `'None'`. The value is a rendering of a
language-specific null, not a wire field, so the local spelling wins.
