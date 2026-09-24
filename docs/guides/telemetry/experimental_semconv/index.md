# Experimental GenAI semantic conventions

`_experimental_semconv` converts an `LlmRequest` and an `LlmResponse` into the
experimental OpenTelemetry GenAI semantic conventions, and emits them as one log
record plus a set of span attributes. Reach for it when a downstream
OpenTelemetry consumer reads the structured `gen_ai.*` message attributes rather
than the legacy ADK span fields.

## Introduction

adk-js already writes ADK's own span attributes in `core/src/telemetry/tracing.ts`:
`gcp.vertex.agent.*`, a flat token count, and a lowercased finish reason. Those
are ADK's shapes. They are not the shapes the OpenTelemetry
[GenAI events specification](https://github.com/open-telemetry/semantic-conventions/blob/v1.39.0/docs/gen-ai/gen-ai-events.md)
describes, so a dashboard built for that specification cannot read them.

This module produces the specification's shapes instead. It is the adk-js port
of adk-python's `src/google/adk/telemetry/_experimental_semconv.py`, and it
writes the same keys with the same values, so a TypeScript agent and a Python
agent report one turn identically.

Three properties are worth knowing before you use it:

- **It never throws.** A value it cannot represent becomes the string
  `<not serializable>`, or `null`, or a dropped entry. Telemetry cannot fail a
  model call.
- **It never mutates its inputs.** The builders are pure. Only the four entry
  points write, and only into the maps you hand them.
- **Nothing in the LLM flow calls it yet.** You drive it yourself. Wiring it into
  the flow needs the port of adk-python's `tracing.py`, which is separate work.

## Get started

Build the two attribute maps, then emit them against a span and an OpenTelemetry
logger.

```ts
import {
  maybeLogCompletionDetails,
  setOperationDetailsAttributesFromRequest,
  setOperationDetailsAttributesFromResponse,
} from '@google/adk';
import {trace} from '@opentelemetry/api';
import {logs} from '@opentelemetry/api-logs';
import type {AnyValueMap} from '@opentelemetry/api-logs';

const details: AnyValueMap = {};
const common: AnyValueMap = {};

setOperationDetailsAttributesFromRequest(details, llmRequest);
setOperationDetailsAttributesFromResponse(llmResponse, details, common);

maybeLogCompletionDetails(
  trace.getActiveSpan(),
  logs.getLogger('adk'),
  details,
  common,
  telemetryConfig,
);
```

[`samples/telemetry/experimental_semconv/agent.ts`](../../../../samples/telemetry/experimental_semconv/agent.ts)
runs this from a plugin against a real model.

For a request that carries one user message, one system instruction, one
declared function and the Google Search tool, the two maps hold this:

```json
{
  "gen_ai.response.finish_reasons": ["stop"],
  "gen_ai.usage.input_tokens": 12,
  "gen_ai.usage.output_tokens": 3,
  "gen_ai.input.messages": [
    {
      "role": "user",
      "parts": [{"content": "Weather in Zurich?", "type": "text"}]
    }
  ],
  "gen_ai.system_instructions": [{"content": "Be terse.", "type": "text"}],
  "gen_ai.tool.definitions": [
    {
      "name": "get_weather",
      "description": "Gets the weather.",
      "parameters": {
        "type": "OBJECT",
        "properties": {"city": {"type": "STRING"}}
      },
      "type": "function"
    },
    {"name": "google_search", "type": "google_search"}
  ],
  "gen_ai.output.messages": [
    {
      "role": "assistant",
      "parts": [{"content": "Sunny.", "type": "text"}],
      "finish_reason": "stop"
    }
  ]
}
```

## The two maps

The module splits its output in two, because the two halves are governed by
different privacy rules.

| Map       | Holds                                                                                                      | Written by                        |
| --------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `details` | `gen_ai.input.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, `gen_ai.output.messages` | both request and response setters |
| `common`  | `gen_ai.response.finish_reasons` and the `gen_ai.usage.*` counters                                         | the response setter               |

`common` is always emitted in full. `details` carries the conversation, so it is
emitted only where the config allows content.

The request setter writes its three keys for every request, with empty lists
when the request carries nothing. The response keys are conditional: the finish
reason appears only when the model reported one, the counters only when the
response carries usage metadata, and `gen_ai.output.messages` only when the
response carries content.

Call the response setter once per response. A turn that arrives as several
streamed chunks accumulates into `gen_ai.output.messages`, one message per
chunk, in arrival order.

Only the chunk that ends the turn reports a finish reason. `@google/genai`
types `FinishReason` as a string enum, so its proto3 zero value
`FINISH_REASON_UNSPECIFIED` is truthy and cannot be told from a real reason by
a truthiness check. It means the model set nothing, so this module treats it as
unreported: `gen_ai.response.finish_reasons` is left out entirely, and the
output message carries `finish_reason: ''`. A healthy turn is therefore never
published as a failed one. adk-python behaves the same way, and the ported test
`test_response_attributes_treat_unspecified_finish_reason_as_unreported` pins
both halves.

## Content capture

`maybeLogCompletionDetails` reads three booleans off the config you pass it.
`ExperimentalSemconvConfig` is structural, so any object carrying these three
properties satisfies it, including a class that exposes them as getters.

| Property                              | Effect                                      |
| ------------------------------------- | ------------------------------------------- |
| `shouldUseExperimentalGenaiSemconv`   | `false` emits nothing at all.               |
| `shouldAddContentToLogs`              | `false` strips content from the log record. |
| `shouldAddContentToExperimentalSpans` | `false` strips content from the span.       |

The two content flags are independent, so a deployment can log the conversation
without putting it on its spans.

With content off, one thing survives: the tool definitions, reported by name and
type. A function keeps its name and description and loses its schema; a built-in
tool is reported verbatim. Messages and instructions do not survive at all.

```json
{
  "gen_ai.tool.definitions": [
    {
      "name": "get_weather",
      "description": "Gets the weather.",
      "parameters": null,
      "type": "function"
    },
    {"name": "google_search", "type": "google_search"}
  ]
}
```

## What lands where

The log record is emitted with the event name
`gen_ai.client.inference.operation.details`, and with a context built from the
span you named. The record is therefore correlated with that span even when the
span is not the active one.

The span gets the same attributes, each serialized to compact JSON. A value that
`JSON.stringify` rejects becomes the string `<not serializable>` instead.

One limitation is worth planning around. `@opentelemetry/sdk-logs` 0.205.0
rejects a log attribute whose value is a list of objects, so the four message
keys do not reach an exporter through its `LogRecord`. The numbers and the
finish reason do. Until that SDK accepts the full `AnyValue` type, read the
message attributes off the span.

## Differences from adk-python

- `Blob.data` is a base64 string here, because that is how `@google/genai`
  encodes it. adk-python emits raw bytes.
- A built-in tool key is converted to `snake_case`, so `googleSearch` reports as
  `google_search` and matches the Python output.
- A `CallableTool` is dropped with one warning. Resolving it needs an `await`,
  which would make every builder asynchronous.
- A tool entry the module cannot recognize is reported as
  `{"name": "UnserializableTool", "type": "<kind>"}` rather than dropped.
