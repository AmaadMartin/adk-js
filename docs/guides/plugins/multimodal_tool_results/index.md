# Multimodal tool results

`MultimodalToolResultsPlugin` lets a function tool return `Part` values instead of a JSON-serialisable object. The plugin puts those parts in front of the model as real content parts. Reach for it when a tool fetches a document, an image, or audio that the model must read as media.

## Introduction

A function tool normally returns an object, and the framework wraps it in a function response. The model then sees the whole thing as text. A tool that returns `{fileUri: 'gs://bucket/report.pdf'}` therefore gives the model a string, not a file it can open.

This plugin closes that gap over two `BasePlugin` hooks. `afterToolCallback` recognises a `Part` or a `Part[]` and saves it in session state. `beforeModelCallback` appends the saved parts to the last content of the next model request. A tool result that is not parts passes through untouched, so the plugin is safe to register alongside tools that return ordinary objects.

The plugin is opt-in and does nothing until you register it on a runner or an app. It never returns a response from `beforeModelCallback`, so it cannot short-circuit a model call.

It is a stopgap. The framework should support a function response part directly; when it does, this plugin becomes unnecessary.

## Get started

Register the plugin, then return parts from your tool.

```typescript
import {
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  MultimodalToolResultsPlugin,
} from '@google/adk';
import {Part} from '@google/genai';

const getReport = new FunctionTool({
  name: 'getReport',
  description: 'fetches the quarterly report',
  execute: async (): Promise<Part[]> => [
    {
      fileData: {
        fileUri: 'gs://bucket/report.pdf',
        mimeType: 'application/pdf',
      },
    },
  ],
});

const runner = new InMemoryRunner({
  agent: new LlmAgent({
    name: 'analyst',
    model: 'gemini-2.5-flash',
    tools: [getReport],
  }),
  plugins: [new MultimodalToolResultsPlugin()],
});
```

The model's next request now carries the file as a part. Your tool may also return a single `Part` rather than an array.

## Retention

`retention` decides how long the parts stay attached.

| Value                         | Behaviour                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `'next_model_call'` (default) | The parts are attached to the very next model request, then cleared.                                                                                   |
| `'session'`                   | `fileData` and `text` parts are also kept in session state and re-attached to every later model request, so a follow-up turn can still reference them. |

```typescript
const plugin = new MultimodalToolResultsPlugin({retention: 'session'});
```

Two properties of `'session'` retention matter.

- `inlineData` parts are always one-shot. Image and audio bytes are never written to session state, whatever the retention. That bounds the size of a stored session and keeps binary payloads out of it.
- A new turn that returns parts **replaces** the stored parts rather than appending to them. Several tool calls within one turn do accumulate.

The constructor throws `InputValidationError` for any other `retention` value.

## What counts as parts

`Part` is a structural interface, so the plugin decides by shape: a value is a part when it is a non-array object that sets at least one field `@google/genai` declares on `Part`. For an array, only the first element is checked, which matches adk-python. An empty array, `null`, a primitive, and a plain record such as `{status: 'ok'}` are all returned unchanged.

## State keys

The plugin exports the two keys it writes, so you can inspect them.

| Key                                                         | Constant                             | Lifetime                                          |
| ----------------------------------------------------------- | ------------------------------------ | ------------------------------------------------- |
| `temp:PARTS_RETURNED_BY_TOOLS_ID`                           | `PARTS_RETURNED_BY_TOOLS_ID`         | The invocation. `temp:` state is never persisted. |
| `multimodal_tool_results_plugin:PARTS_RETURNED_BY_TOOLS_ID` | `SESSION_PARTS_RETURNED_BY_TOOLS_ID` | The session, under `'session'` retention.         |

A model request with no contents is left alone and the saved parts stay pending for a later request.
