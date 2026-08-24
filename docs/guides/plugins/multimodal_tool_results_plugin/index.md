# MultimodalToolResultsPlugin

`MultimodalToolResultsPlugin` lets a function tool return multimodal content — an image, an audio clip, a PDF — and have the model actually receive it. Reach for it when a tool produces a `Part` rather than a value that reads well as JSON.

## Introduction

A function tool returns a value, and ADK wraps that value into the JSON function response it sends back to the model. That works for a number or a record. It does not work for media: a `Part` from `@google/genai` is stringified, so the model reads a JSON dump of a file URI or a base64 blob instead of seeing the file.

This plugin closes that gap without changing the tool result. It watches every tool call through `afterToolCallback`. When a tool returns a `Part`, or a non-empty array of `Part`s, the plugin buffers those parts in the invocation state. On the next model call it appends them to the last content of the request, so they arrive as real parts next to the function response.

The plugin is a `BasePlugin`, so you register it on a runner or an `App` and every tool of every agent under it is covered. It is a workaround for the missing support of `FunctionResponse.parts` outside the computer-use tool, and it mirrors adk-python's plugin of the same name.

## Get started

Register the plugin on your runner. The tool returns a `Part` directly.

```typescript
import {
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  MultimodalToolResultsPlugin,
} from '@google/adk';
import {createPartFromUri} from '@google/genai';

const getChart = new FunctionTool({
  name: 'get_chart',
  description: 'Returns the latest revenue chart.',
  execute: () => createPartFromUri('gs://bucket/chart.png', 'image/png'),
});

const agent = new LlmAgent({
  name: 'analyst',
  model: 'gemini-2.5-flash',
  instruction: 'Describe the chart the tool returns.',
  tools: [getChart],
});

const runner = new InMemoryRunner({
  agent,
  plugins: [new MultimodalToolResultsPlugin()],
});
```

Without the plugin the model receives `{"result": {"fileData": {...}}}` as text. With it, the image part is appended to the request that follows the tool call.

## Retention

The constructor takes a retention mode that decides how long the parts stay attached.

| Mode                          | Behaviour                                                                                                      |
| :---------------------------- | :------------------------------------------------------------------------------------------------------------- |
| `'next_model_call'` (default) | The parts are attached to the next model request, then cleared.                                                |
| `'session'`                   | The parts of the most recent turn that returned any stay attached to every later model request of the session. |

```typescript
new MultimodalToolResultsPlugin({retention: 'session'});
```

Use `'session'` when a follow-up turn should still be able to refer to the file: "now compare it with last quarter". Use the default when the tool result is only relevant to the answer it feeds.

`'session'` replaces rather than accumulates across turns: a turn that returns new parts drops the previous turn's parts. An `inlineData` part is the exception in either mode. It is always one-shot, because it carries the raw bytes inline and retaining it would write the payload into persisted session state on every turn.

## Behaviour to know about

**Part detection is structural.** `Part` is an interface whose fields are all optional, so the plugin recognises a part by its field names. An object qualifies when every own property is a `Part` field and at least one of them is defined. A plain tool result shaped exactly like a part, such as `{text: 'ok'}`, is therefore treated as a part. Give such a result another field name, or wrap it, if you do not want it attached.

**Only the first element of an array is checked.** An array whose first element is a `Part` is taken whole. This matches adk-python.

**The session buffer has no cap within a turn.** Each tool call that returns parts adds to it, and it is cleared only when a later turn returns parts of its own.

**An empty request is a no-op.** If `llmRequest.contents` is empty the plugin attaches nothing and keeps the buffered parts for the next call.
