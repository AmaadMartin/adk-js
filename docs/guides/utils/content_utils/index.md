# content_utils

`content_utils` holds the shared helpers that read and reshape a genai
`Content`. Reach for it whenever you need the text of a content, need to know
whether a part is audio, or need to turn an arbitrary value into a user turn.

## Introduction

Three ADK subsystems ask the same questions of a `Content`, and each used to
answer them on its own. A live connection asks "which parts may I replay?". A
workflow node asks "what is the text of this model turn?". A plugin asks "how do
I mark a part the model never produced?". Answering these in each caller let the
answers drift: one text extractor kept the model's reasoning and another dropped
it, so the same content produced different text depending on who read it.

The module is internal. It is not exported from `@google/adk`, and it mirrors
`google/adk-python` `utils/content_utils.py` symbol for symbol, so the two SDKs
agree on what these words mean.

Two of its rules are worth knowing even if you never import it, because they
decide what the model sees:

- A **thought part is not text.** A part with `thought: true` carries the
  model's reasoning. `extractTextFromContent` skips it, so reasoning never
  reaches a node output or a tool's arguments.
- **Audio is not replayed.** When ADK replays history to a live session, it
  strips audio parts. The audio is already transcribed in the same history, and
  resending it makes the model answer twice.

## Get started

```ts
import {
  extractTextFromContent,
  filterAudioParts,
  isAudioPart,
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
isAudioPart({inlineData: {mimeType: 'audio/pcm', data: 'AAE='}}); // true
filterAudioParts({
  role: 'user',
  parts: [{text: 'hi'}, {inlineData: {mimeType: 'audio/pcm', data: 'AAE='}}],
}); // {role: 'user', parts: [{text: 'hi'}]}
```

## The helpers

### `extractTextFromContent(content)`

Returns the text of a content, excluding its thought parts. It returns `''` for
`undefined`, for `null`, and for a content with no text.

Parts are joined with no separator. The model emits one logical string and
chunks it across parts arbitrarily, so any separator would corrupt it.

### `isAudioPart(part)`

Returns whether a part carries audio, by `inlineData` MIME type or by
`fileData` MIME type. The check is a prefix match on the top-level type, so
`application/audio-ish` is not audio. A part with no MIME type is not audio: an
unlabelled blob cannot be proven to be audio, so it is kept.

### `filterAudioParts(content)`

Returns a copy of the content with its audio parts removed, keeping the role and
the order of the parts that survive. It never mutates its argument.

It returns `undefined` when nothing survives, including when the content had no
parts to begin with. That tells the caller to drop the whole content rather than
send one with no parts.

### `toUserContent(value)`

Coerces any value into a `user`-role `Content`.

| Input                 | Result                                        |
| --------------------- | --------------------------------------------- |
| a `Content`           | the same parts, re-roled to `user`            |
| a string              | one text part holding it                      |
| an object or an array | one text part holding `JSON.stringify(value)` |
| anything else         | one text part holding `String(value)`         |

`JSON.stringify` honours a `toJSON()` method, and it emits non-ASCII verbatim
rather than as `\uXXXX` escapes. Escaped text costs extra prompt tokens and
degrades the model's answers for non-English input.

A circular or `BigInt`-bearing value throws out of `JSON.stringify`.
`toUserContent` does not catch it, matching adk-python, where `json.dumps`
raises.

### `SKIP_THOUGHT_SIGNATURE_VALIDATOR`

The placeholder `Part.thoughtSignature` that bypasses backend validation. Set it
on a part you synthesize yourself, so the Gemini backend accepts the fabricated
part instead of rejecting it for a missing signature.

The backend matches the decoded bytes `skip_thought_signature_validator`. The
genai JS SDK carries a proto `bytes` field as a base64 string, so the constant
is that value base64-encoded — unlike adk-python, where it is a `bytes` literal.

## Divergence from adk-python

`toUserContent(null)` produces the text `'null'`, where Python's `str(None)`
produces `'None'`. JavaScript has no `'None'`. The value is a rendering of a
language-specific null, not a wire field, so the local spelling wins.
