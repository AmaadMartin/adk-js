# EventActions

`EventActions` carries what an event asks the runner to do: the state and
artifact updates it applies, the transfer or escalation it requests, the
credentials a tool needs, and the summary of a compacted range of events. Reach
for it when you build an event by hand, or when you read one back from a session
and need to know what it changed.

## Introduction

An ADK event has two halves. The content is what the model or the user said. The
actions are what the runner must do about it. Keeping the two apart lets a
session store one ordered log that replays into the same state.

Both SDKs must agree on the field names, because a session written by a Python
runner is read by a JavaScript runner and the reverse. This module mirrors
`google/adk-python`
[`event_actions.py`](https://github.com/google/adk-python/blob/main/src/google/adk/events/event_actions.py).
A field it does not have is a field that is dropped when the event crosses the
boundary.

`createEventActions` is the supported way to build one. It fills in the four
dictionary fields, and it rejects a key that `EventActions` does not declare.
The reference model sets `extra='forbid'` for the same reason: a misspelled
action is a silent loss otherwise.

## Get started

```ts
import {createEventActions} from '@google/adk';

const actions = createEventActions({
  stateDelta: {cartSize: 2},
  transferToAgent: 'billing_agent',
});

// actions.artifactDelta is {}
// actions.escalate is undefined
```

`createEvent` builds the actions for you, so pass a partial and read the result
back from the event:

```ts
import {createEvent} from '@google/adk';

const event = createEvent({author: 'billing_agent', actions: {escalate: true}});

// event.actions.escalate is true
// event.actions.stateDelta is {}
```

## Unknown keys are rejected

TypeScript already rejects a stray key in an object literal. The runtime check
covers the callers the compiler never sees: plain JavaScript, and an object
widened to `Record<string, unknown>` before it arrives.

```js
createEventActions({transferAgent: 'other_agent'});
// InputValidationError: EventActions received unknown key(s): transferAgent.
// Fields are camelCase; see EventActions.
```

Fields are camelCase here. `google/adk-python` accepts `state_delta` as well as
`stateDelta`, because pydantic's `populate_by_name` allows both. This SDK
converts snake_case to camelCase at the wire boundary, in
`transformToCamelCaseEvent`, so a snake_case key that reaches
`createEventActions` is a bug and the check reports it.

The check runs on what you construct. An event rehydrated from storage is cast,
not constructed, so a stored event is not validated.

## Compaction

`compaction` holds the range of events one event summarizes, and the summary
that stands in for them. All three fields are required:

```ts
import {createEventActions, EventCompaction} from '@google/adk';

const compaction: EventCompaction = {
  startTimestamp: 1000,
  endTimestamp: 2000,
  compactedContent: {role: 'model', parts: [{text: 'the story so far'}]},
};

const actions = createEventActions({compaction});
```

`startTimestamp` and `endTimestamp` use the unit of `Event.timestamp`,
milliseconds since the epoch. Python records seconds there, and neither side
converts.

`createEventActions` rejects a compaction that is not an object, that misses a
field, that holds a non-finite timestamp, or that carries a key
`EventCompaction` does not declare:

```js
createEventActions({compaction: {startTimestamp: 1000, endTimestamp: '2000'}});
// InputValidationError: compaction.endTimestamp must be a finite number.
```

The field survives `transformToSnakeCaseEvent` and `transformToCamelCaseEvent`
in both directions, including the argument keys of a tool call inside the
summary: `args` and `response` payloads keep their spelling, while `Content`'s
own keys convert.

This SDK's own compaction pipeline uses `CompactedEvent` instead, and reads
nothing from this field. `compaction` is here so a compaction written by a
Python runner survives a round trip through adk-js.
