# Conformance recordings schema

`recordings_schema.ts` declares the format of a conformance
`generated-recordings.yaml` file as Zod schemas. The conformance loader parses
every recordings file with it. Reach for it when you hand-write or hand-edit a
recordings file, or when you add a field to the recording format.

## Introduction

The conformance harness runs an agent twice. A record pass captures every LLM
exchange and every tool call into `generated-recordings.yaml`. A replay pass
reads that file back and answers the agent from it, so the test needs no model
and no network. `ReplayPlugin` selects a recording by `userMessageIndex` and
`agentName`, then returns the recorded response.

The file is therefore a contract between the recorder and the replayer. Before
this schema existed the loader cast the parsed YAML to a TypeScript interface.
An interface is erased at compile time, so a mistyped key survived the load. The
recording looked present and its payload was invisible, and the run failed later
with `No tool recording found for agent X at turn 0` — an error that points at
the wrong thing.

The schemas mirror adk-python's `recordings_schema.py`, including its
`extra="forbid"` strictness. They validate the four recording envelopes. They do
not validate the recorded payloads field by field: an `LlmRequest`, an
`LlmResponse`, a `FunctionCall` and a `FunctionResponse` are checked to be
objects and carry their SDK type statically. A hand-written schema for those
would duplicate the SDK's own definitions and would reject a valid recording
every time the SDK adds a field.

## Get started

The loader already parses for you. Call the schema directly when you build or
check a recordings document yourself:

```ts
import {RecordingsSchema} from '../integration/recordings_schema.js';

const recordings = RecordingsSchema.parse({
  recordings: [
    {
      userMessageIndex: 0,
      agentName: 'dice_agent',
      toolRecording: {
        toolCall: {name: 'roll_die', args: {sides: 6}},
        toolResponse: {name: 'roll_die', response: {result: 4}},
      },
    },
  ],
});
```

`parse` returns a typed `Recordings` and throws a `ZodError` on anything else.
`recordings_schema.ts` exports the four inferred types alongside the schemas:
`Recordings`, `Recording`, `LlmRecording` and `ToolRecording`.

## The four models

| Schema                | Fields                                                                             |
| --------------------- | ---------------------------------------------------------------------------------- |
| `RecordingsSchema`    | `recordings`, defaulting to `[]`                                                   |
| `RecordingSchema`     | `userMessageIndex` and `agentName`, both required; `llmRecording`; `toolRecording` |
| `LlmRecordingSchema`  | `llmRequest`, `llmResponse`, `llmResponses`                                        |
| `ToolRecordingSchema` | `toolCall`, `toolResponse`                                                         |

`userMessageIndex` and `agentName` are the two fields `ReplayPlugin` filters on,
so they are required. `userMessageIndex` must be an integer, and the schema does
not coerce: a quoted `'0'` in YAML is an error, not a zero.

An absent `recordings` key parses as an empty list, matching adk-python's
`Field(default_factory=list)`. `RecordingsSchema.parse({})` yields
`{recordings: []}`.

## `llmResponse` and `llmResponses`

adk-python records the responses streamed for one request as a list,
`llm_responses`. adk-js records a single `llmResponse`. Both fields are present
on `LlmRecordingSchema`, and `ReplayPlugin` reads both: it returns
`llmResponse` when it is set, and the single entry of `llmResponses` otherwise.

A `beforeModelCallback` answers one model call with one response, so adk-js
cannot replay a recording holding several. That recording is refused by name:

```
Cannot replay a recording holding 2 llmResponses: one model call is answered
with one response.
```

## What strictness buys you

An unknown key fails the load and names itself. Take a recordings file with the
plural typo `tool_recordings`:

```yaml
recordings:
  - user_message_index: 0
    agent_name: dice_agent
    tool_recordings:
      tool_call:
        name: roll_die
```

The loader camelizes the keys before parsing, so the error names the camelized
key and the path to it:

```
[
  {
    "code": "unrecognized_keys",
    "keys": [
      "toolRecordings"
    ],
    "path": [
      "recordings",
      0
    ],
    "message": "Unrecognized key: \"toolRecordings\""
  }
]
```

This is a behaviour change for `@google/adk-devtools`. A recordings file that
loaded before, with the unknown key silently dropped, now fails at the load.
That is the intent: the failure points at the file and the key instead of at a
replay that has already gone wrong.
