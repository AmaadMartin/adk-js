# Session to eval format

`convertSessionToEvalFormat` turns a recorded `Session` into the eval-set turn
records that the ADK evaluation tooling reads. Reach for it when you want to
promote a real conversation into an eval set instead of writing the turns by
hand.

## Introduction

An eval set is a list of turns. Each turn holds the user's query, the tool calls
the agent is expected to make, and the reference answer. Writing those turns by
hand is slow and drifts from what the agent really does.

A `Session` already holds that information, but in a different shape: a flat
list of events, where one user event is followed by the agent events it
produced. `convertSessionToEvalFormat` regroups that list into one record per
user-initiated turn.

The function is the TypeScript port of `adk-python`'s
`google.adk.cli.utils.evals.convert_session_to_eval_format`. Like the Python
module, it is internal to the developer tooling: the `@google/adk-devtools`
package does not re-export it. It is the piece the dev server's
`POST /apps/:appName/eval_sets/:evalSetId/add_session` route needs. That route
still answers `501 Not Implemented`, so today the function has no caller inside
the repository.

The function is pure. It reads the session, allocates new records, and changes
nothing.

## Get started

The module is `dev/src/utils/evals.ts`. The import below is written as a caller
in `dev/src/server/` would write it.

```ts
import {createEvent, createSession} from '@google/adk';

import {convertSessionToEvalFormat} from '../utils/evals.js';

const session = createSession({
  id: 'session-1',
  appName: 'home_automation_agent',
  userId: 'user',
  events: [
    createEvent({
      author: 'user',
      content: {role: 'user', parts: [{text: 'turn off device_2'}]},
    }),
    createEvent({
      author: 'agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'set_device_info',
              args: {device_id: 'device_2', status: 'OFF'},
            },
          },
        ],
      },
    }),
    createEvent({
      author: 'agent',
      content: {role: 'model', parts: [{text: 'device_2 is off.'}]},
    }),
  ],
});

const turns = convertSessionToEvalFormat(session);
```

`turns` is:

```json
[
  {
    "query": "turn off device_2",
    "expected_tool_use": [
      {
        "tool_name": "set_device_info",
        "tool_input": {"device_id": "device_2", "status": "OFF"}
      }
    ],
    "expected_intermediate_agent_responses": [],
    "reference": "device_2 is off."
  }
]
```

The property names are `snake_case` because these records are written verbatim
into `.evalset.json` files. `adk-python`'s evaluation tooling reads those files,
so the field names must match on both sides.

## How a turn is built

A turn starts at an event whose author is `user` and ends at the next such
event, or at the end of the session.

| Field                                   | Source                                           |
| --------------------------------------- | ------------------------------------------------ |
| `query`                                 | the text of the **first** part of the user event |
| `expected_tool_use`                     | every `functionCall` part in the turn, in order  |
| `expected_intermediate_agent_responses` | every agent text response except the last        |
| `reference`                             | the text of the **last** agent text response     |

A part that carries both a `functionCall` and text counts only as a tool call.
Its text is dropped.

## Guarantees

- The function never throws. A malformed or partial event is skipped.
- `expected_tool_use` and `expected_intermediate_agent_responses` are always
  arrays. `query` and `reference` are always strings.
- An event with no content, or with an empty `parts` array, contributes nothing.
  A user event like that produces no turn. An agent event like that does not
  close the turn.
- An agent event with no author is recorded as `agent`. An empty author string
  is recorded the same way.
- The session and every object inside it stay unchanged. `tool_input` is the
  same object as the source `functionCall.args`, so do not modify it.
- Turns follow session order. Within a turn, tool calls and responses follow
  event order and then part order.

## Difference from adk-python

The Python reference finds the scan start with `events.index(event)`, which
returns the first structurally equal event. A session that repeats one event
therefore restarts the scan at the wrong position, and the repeated turns get
the first turn's tool calls. This port scans from the loop index, so each
occurrence gets its own turn body.
