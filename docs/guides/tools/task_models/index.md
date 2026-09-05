# Task models

The task models validate the payloads that a task-mode agent delegation writes
into a session. Reach for them when you read such a payload back: from a
persisted session, or from a session that adk-python wrote.

## Introduction

A task-mode `LlmAgent` delegates work to a sub-agent. Two payloads describe that
exchange. The delegation payload names the target agent and carries its input.
The completion payload carries the output the agent produced. Both are written
into the session, so both survive a round trip through JSON.

That round trip is the problem these models solve. A value read back from a
session arrives as `unknown`, and the compiler never saw it. Worse, the writer
may be the other SDK: adk-python's `model_dump()` emits `agent_name`, while
TypeScript code writes `agentName`. A reader that trusts the shape either
crashes later or, more quietly, treats a corrupt payload as a valid one.

Each model has one parser, and the parser is the validation boundary. It accepts
both spellings of the agent name, rejects an unknown key, names the field that
was wrong, and returns a frozen object.

These symbols are internal to adk-js. They are not exported from
`@google/adk`; code inside `core/src` imports them by relative path. The
counterpart of adk-python's `_DefaultTaskOutput` is not here — it already exists
as the default output schema in `finish_task_tool.ts`.

## Get started

`parseTaskRequest` validates a delegation payload.

```typescript
import {parseTaskRequest} from './task_models.js';

const request = parseTaskRequest({
  agentName: 'researcher',
  input: {topic: 'a'},
});
// {agentName: 'researcher', input: {topic: 'a'}}
```

`asTaskRequest` is the same check for a value of unknown provenance, such as one
read out of a session. It logs the received type before it rejects a value that
is not an object, so a corrupt session shows up in the log rather than only in
the exception.

```typescript
import {asTaskRequest} from './task_models.js';

// `stored` came out of a session, so the compiler knows nothing about it.
const stored: unknown = JSON.parse(serialized);
const request = asTaskRequest(stored);
```

`parseTaskResult` validates a completion payload.

```typescript
import {parseTaskResult} from './task_models.js';

const result = parseTaskResult({output: {summary: 'done'}});
```

`parseDefaultTaskInput` validates the default input of a task agent that
declares no input schema.

```typescript
import {parseDefaultTaskInput} from './task_models.js';

const input = parseDefaultTaskInput({goal: 'Summarize the paper.'});
// {goal: 'Summarize the paper.'}  -- an absent field stays absent.
```

## Wire compatibility with adk-python

`parseTaskRequest` and `asTaskRequest` accept the `agent_name` spelling and
return `agentName`.

```typescript
parseTaskRequest({agent_name: 'researcher', input: {}});
// {agentName: 'researcher', input: {}}
```

The rename covers that one top-level key. It is not recursive, because `input`
holds an arbitrary user payload whose own keys belong to the caller.

```typescript
parseTaskRequest({
  agent_name: 'a',
  input: {topic_id: 42, sub_task: {step_1: 1}},
});
// input is returned exactly as given: topic_id and step_1 keep their spelling.
```

A payload that writes both spellings is rejected rather than deduplicated. One
of the two values would have to be dropped, and a silent drop is the failure
this boundary exists to prevent.

```typescript
parseTaskRequest({agent_name: 'a', agentName: 'b', input: {}});
// throws InputValidationError: Unrecognized key: "agent_name"
```

## Validation rules

Every parser throws `InputValidationError` on the first problem it finds, with a
message naming the offending field.

- An unknown key is an error. A task payload originates with a model or with
  whatever last wrote the session, so an unexpected key is a signal, not
  something to pass through.
- `TaskResult.output` is required but nullable. The key must be present, and its
  value may be anything, including `null`.
- `DefaultTaskInput.goal` and `background` are optional. A `null` becomes
  `undefined`, matching `Optional[str] = None` in adk-python.

```typescript
parseTaskResult({}); // throws: output is required.
parseTaskResult({output: null}); // {output: null}
```

Every parser returns a frozen object, so a later write to a parsed payload
throws a `TypeError` instead of corrupting the value the session holds.
