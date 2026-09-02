# EventActions

`EventActions` carries the side-effects of an event: the state and artifact
updates it applies, the transfer or escalation it requests, the credentials a
tool needs, and the route a workflow node emitted. Reach for it when you build
an event by hand, or when you read one back out of a session and need to know
what it asked the runner to do.

## Introduction

An ADK event has two halves. The content is what the model or the user said.
The actions are what the runner must do about it. Keeping the two apart lets a
session store one ordered log that replays into the same state.

That is also why the field set matters. A session written by a Python runner is
read by a JavaScript runner and the reverse, so both SDKs must agree on the
field names on the wire. This module mirrors `google/adk-python`
[`event_actions.py`](https://github.com/google/adk-python/blob/main/src/google/adk/events/event_actions.py).
A field it does not have is a field that is dropped when the event crosses the
boundary.

Two behaviours guard the type rather than extend it. `createEventActions`
rejects a malformed `requestedAuthConfigs` entry, and `serializeEventActions`
makes session state safe to persist when a tool put a value in it that JSON
cannot represent.

## Get started

`createEventActions` fills in the four dictionary fields and leaves every
scalar field unset:

```ts
import {createEventActions} from '@google/adk';

const actions = createEventActions({
  stateDelta: {cartSize: 2},
  transferToAgent: 'billing_agent',
  transferReason: 'the user asked about an invoice',
});

// actions.artifactDelta is {}
// actions.transferReason is 'the user asked about an invoice'
```

`createEvent` builds the actions for you, so pass a partial and read the result
back from the event:

```ts
import {createEvent} from '@google/adk';

const event = createEvent({
  author: 'billing_agent',
  actions: {setModelResponse: {invoice_id: 'INV-42', total: 19.99}},
});

// event.actions.setModelResponse is {invoice_id: 'INV-42', total: 19.99}
```

`setModelResponse` holds a structured result whose shape only the model and
your code know. Its keys survive a round trip through storage exactly as
written: `invoice_id` stays `invoice_id`, and `invoiceId` stays `invoiceId`.

## Routes live in two places

The workflow engine reads `event.route`. `google/adk-python` stores the route
on `actions.route`, and only that copy crosses the wire. `createEvent` copies
the route you supply onto `actions.route`, so a route you emit reaches the
other SDK:

```ts
import {createEvent} from '@google/adk';

const emitted = createEvent({author: 'router', route: 'approved'});
// emitted.actions.route is 'approved'
```

`DatabaseSessionService` fills the other direction: when it reads a stored
event whose route sits only on `actions.route`, it copies the route onto
`event.route`. A route written by a Python runner therefore reaches the engine
unchanged.

A route key is a string, a number or a boolean, and an array of keys fires
every matching branch.

## Fields this SDK carries but does not act on

Two fields exist so an event written by a Python runner keeps them. Nothing in
this SDK reads either one yet.

`compaction` holds the range of events a summary replaces, as
`{startTimestamp, endTimestamp, compactedContent}`. This SDK's own compaction
pipeline uses `CompactedEvent` instead, which keeps the same range on the event
itself. `rewindBeforeInvocationId` names the invocation a rewind event returns
to, and this SDK has no rewind support.

Both round-trip through storage under their Python names,
`compaction.start_timestamp` and `rewind_before_invocation_id`. The timestamps
use the unit of `Event.timestamp`, milliseconds. The Python model records
seconds, and neither side converts.

## Session state that JSON cannot represent

A tool writes to session state through the tool context, and nothing stops it
from storing a callback or a `BigInt`. `JSON.stringify` throws on a `BigInt` or
a circular reference, and it drops a function. One such value used to cost you
the whole event.

`serializeEventActions` replaces the value with a string stand-in and keeps its
siblings:

```ts
import {createEventActions, serializeEventActions} from '@google/adk';

const actions = createEventActions({
  stateDelta: {retries: 2, onDone: () => 'finished'},
});

const safe = serializeEventActions(actions);
// safe.stateDelta['retries'] is 2
// safe.stateDelta['onDone'] is '[Function: onDone]'
```

It applies to `stateDelta` and `agentState`, the two fields that hold values
your own code chose. It never throws and it never changes its argument.

| Value                      | Stand-in                                         |
| -------------------------- | ------------------------------------------------ |
| function                   | `[Function: <name>]`, or `[Function: anonymous]` |
| `BigInt`                   | its decimal digits, e.g. `'42'`                  |
| symbol                     | its description, e.g. `'Symbol(token)'`          |
| a reference back to itself | `[Circular]`                                     |

A `Date` keeps its ISO string, because a `Date` serializes already. Each field
that needed a replacement writes one warning:

```
Failed to serialize `stateDelta`; some values are not JSON-serializable
(e.g. functions) and will be replaced with a string representation in the
persisted event.
```

`DatabaseSessionService` calls this before it writes an event, so application
code does not need to. Call it yourself only if you write your own session
service.

## Rejecting a malformed auth request

`requestedAuthConfigs` maps a function call id to the `AuthConfig` that call
needs. An entry that lost its `authScheme` or its `credentialKey` used to be
accepted here and to fail much later, inside the auth flow.
`createEventActions` now throws `InputValidationError` for such an entry, and
the message names the offending key:

```
requestedAuthConfigs['call-1'] is not a valid AuthConfig: expected an object
with 'authScheme' and 'credentialKey'.
```

`isAuthConfig` performs the same check on its own, which is useful when you
restore an event from your own storage:

```ts
import {isAuthConfig} from '@google/adk';

const restored: unknown = JSON.parse('{"credentialKey": "billing-key"}');
// isAuthConfig(restored) is false: the entry has no authScheme
```

The check is structural. It confirms both required properties are present. It
does not confirm the scheme is one ADK supports, or that the credential key
names a stored credential.
