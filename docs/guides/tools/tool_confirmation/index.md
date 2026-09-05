# ToolConfirmation

`ToolConfirmation` carries a human decision about one gated tool call:
whether the call is approved, the hint the user was shown, and any extra data
the flow needs. `ToolConfirmation.fromResponseDict` reads that decision out of
the function response a client sends back.

## Introduction

A tool that requires confirmation does not run on the first pass. The framework
emits an `adk_request_confirmation` function call, and the conversation pauses.
The client answers with a function response, and the resume path reads the
decision out of it.

A client can send that answer in two shapes. It can send the fields directly,
or it can wrap them in a JSON string under a single `response` key. The ADK
client uses the second shape. `fromResponseDict` accepts both, so a caller does
not have to know which client produced the answer.

The parsing is strict. A key outside `hint`, `confirmed` and `payload` is an
error, not an extension point. A dropped key would let a client believe it set
a field that never took effect, and for an approval gate that is the wrong
direction to fail in.

## Get started

Both shapes below produce the same confirmation.

```ts
import {ToolConfirmation} from '@google/adk';

// The fields, sent directly.
const direct = ToolConfirmation.fromResponseDict({
  hint: 'Approve the transfer?',
  confirmed: true,
  payload: {ticket: 'T-1'},
});

// The same fields, inside the ADK client's JSON envelope.
const wrapped = ToolConfirmation.fromResponseDict({
  response: JSON.stringify({
    hint: 'Approve the transfer?',
    confirmed: true,
    payload: {ticket: 'T-1'},
  }),
});

// direct.confirmed === wrapped.confirmed === true
// direct.payload and wrapped.payload are both `{ticket: 'T-1'}`.
```

An empty object is legal and means "not confirmed":

```ts
import {ToolConfirmation} from '@google/adk';

const confirmation = ToolConfirmation.fromResponseDict({});

// confirmation.hint === ''
// confirmation.confirmed === false
// confirmation.payload === undefined
```

## What counts as the envelope

Only a lone `response` key is the envelope. A `response` key next to other keys
is a plain field set, so `response` is then an unknown key and the call throws.

| Input                                    | Result                                               |
| ---------------------------------------- | ---------------------------------------------------- |
| `{}`                                     | `hint: ''`, `confirmed: false`, `payload: undefined` |
| `{hint, confirmed, payload}`, any subset | those values, the rest defaulted                     |
| `{response: '<json object>'}`, sole key  | the decoded object, then validated                   |
| `{response: '<json>', hint: 'h'}`        | throws — two keys, so `response` is unknown          |
| any other key                            | throws                                               |

## Failures

Every failure throws `InputValidationError`. The message names the problem and
the `cause` carries the underlying error, so a caller can inspect it.

```ts
import {InputValidationError, ToolConfirmation} from '@google/adk';

try {
  ToolConfirmation.fromResponseDict({confirmd: true});
} catch (e: unknown) {
  if (e instanceof InputValidationError) {
    // e.message: 'ToolConfirmation received unknown key(s): confirmd.'
    // e.cause: the ZodError that refused the key.
  }
}
```

The `cause` is the `SyntaxError` when the envelope does not decode, and the
`ZodError` when the fields do not match the shape. A message never quotes a
value out of the response, because the response is caller-controlled and must
not reach a log.

## Two rules worth knowing

**`payload` is opaque.** It is carried by reference and never inspected,
cloned, or renamed. Keys inside it survive exactly as the client wrote them,
`snake_case` included.

**`confirmed` must be boolean `true`.** A string `'true'` throws rather than
approving the call. Readers of the field test it for truthiness, so a truthy
non-boolean would approve a call nobody agreed to.
