# EvalConstants

`EvalConstants` names the seven keys of the ADK evaluation dataset file format.
Reach for it when your code reads or writes an ADK `*.test.json` dataset, so the
keys come from one shared vocabulary instead of bare string literals.

## Introduction

An ADK evaluation dataset is a JSON array. Each entry records one turn: the user
query, the tool calls the agent was expected to make, and the reference answer.
Users author these files by hand and keep them in their repositories, so the key
names are part of a public file format. They are snake_case and they are frozen.

That makes them different from ordinary internal identifiers. A typo in
`'expected_tool_use'` does not fail to compile — it reads `undefined` at runtime
from a file that is perfectly valid. `EvalConstants` moves that mistake to
compile time.

The values are identical to adk-python's `EvalConstants`, so the same dataset
file works in both SDKs.

| Member              | Value               |
| ------------------- | ------------------- |
| `QUERY`             | `query`             |
| `EXPECTED_TOOL_USE` | `expected_tool_use` |
| `RESPONSE`          | `response`          |
| `REFERENCE`         | `reference`         |
| `TOOL_NAME`         | `tool_name`         |
| `TOOL_INPUT`        | `tool_input`        |
| `MOCK_TOOL_OUTPUT`  | `mock_tool_output`  |

## Get started

```ts
import {EvalConstants} from '@google/adk';

interface ExpectedToolUse {
  tool_name: string;
  tool_input: Record<string, string>;
}

interface DatasetEntry {
  query: string;
  expected_tool_use: ExpectedToolUse[];
  reference: string;
}

const entry: DatasetEntry = {
  query: 'Turn off device_2 in the Bedroom.',
  expected_tool_use: [
    {
      tool_name: 'set_device_info',
      tool_input: {location: 'Bedroom', device_id: 'device_2', status: 'OFF'},
    },
  ],
  reference: "OK. I've turned off device_2 in the Bedroom. Anything else?\n",
};

const firstTool = entry[EvalConstants.EXPECTED_TOOL_USE][0];
firstTool[EvalConstants.TOOL_NAME]; // 'set_device_info'
```

## What each key holds

- `QUERY` — the user message that starts the turn.
- `EXPECTED_TOOL_USE` — an array of expected tool calls, in order.
- `TOOL_NAME` and `TOOL_INPUT` — the name and arguments of one expected call.
- `MOCK_TOOL_OUTPUT` — an optional canned result for that call. An evaluation
  runner returns it instead of running the tool.
- `RESPONSE` — the agent answer recorded when the dataset was captured.
- `REFERENCE` — the answer the agent is graded against.

Only `MOCK_TOOL_OUTPUT` is optional inside an expected tool call. A dataset entry
may omit `RESPONSE` or `EXPECTED_TOOL_USE` when the turn does not need them.

## Scope

`EvalConstants` is a declaration and nothing more. It has no runtime behaviour,
it validates nothing, and adk-js does not yet ship an evaluation runner that
reads these datasets. Use it to keep your own reader or writer honest.
