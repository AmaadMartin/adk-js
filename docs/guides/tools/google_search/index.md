# GoogleSearchTool

`GoogleSearchTool` grounds a Gemini model's answers in Google Search. Reach for
it when the agent must answer questions about facts that are newer than the
model's training data.

## Introduction

`GoogleSearchTool` is a built-in tool. A built-in tool has no function
declaration and no local implementation: the model runs it inside its own
serving stack and returns the grounded answer. Your process never sees a
function call for it. That is the difference from `FunctionTool`, where the
model asks ADK to run your code and waits for the result.

Because the model runs the tool, the tool must know that the model supports it.
`processLlmRequest` inspects the request and appends a `googleSearch` entry to
`config.tools`. It appends `googleSearchRetrieval` instead for a Gemini 1.x
model, which uses the older request shape. For any other model it throws,
rather than sending a request the model rejects.

Three things open that gate:

- The request names a Gemini model.
- The `ADK_DISABLE_GEMINI_MODEL_ID_CHECK` environment variable is enabled. Use
  it when your Gemini deployment does not follow the public `gemini-*` naming.
- The request carries `isManagedAgent: true`. See
  [Managed-agent requests](#managed-agent-requests).

A request with no model reaches no model, so the tool leaves it alone and
returns. Every built-in tool behaves this way. The managed-agent flag is the
exception, because such a request has no model by design.

## Get started

Add the shared `GOOGLE_SEARCH` instance to an agent's `tools`:

```typescript
import {GOOGLE_SEARCH, LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'search_assistant',
  description: 'An assistant that can search the web.',
  model: 'gemini-flash-latest',
  instruction:
    'You are a helpful assistant. Answer user questions using Google Search when needed.',
  tools: [GOOGLE_SEARCH],
});
```

## Configuration

Construct your own instance when you need one of the two options:

```typescript
import {GoogleSearchTool} from '@google/adk';

const searchTool = new GoogleSearchTool({
  // Validate this model instead of the one on the request, and send the
  // request to it.
  model: 'gemini-2.5-flash',
  // Allow the tool to sit beside other tools on a Gemini 1.x model.
  bypassMultiToolsLimit: true,
});
```

`model` overwrites `llmRequest.model` before the gate runs, so the tool
validates the model you named. `bypassMultiToolsLimit` only affects Gemini 1.x:
that model version rejects Google Search beside another tool, so the tool
throws unless you set the option. Gemini 2 and later accept the combination and
ignore the option.

## Managed-agent requests

A managed agent resolves its tools server-side, so the request it builds carries
no model at all. `LlmRequest.isManagedAgent` marks such a request, and the tool
enables itself on it without a model check:

```typescript
import {GOOGLE_SEARCH, LlmRequest} from '@google/adk';

const llmRequest: LlmRequest = {
  contents: [],
  config: {},
  toolsDict: {},
  liveConnectConfig: {},
  isManagedAgent: true,
};
```

After `GOOGLE_SEARCH.processLlmRequest({llmRequest, toolContext})`,
`llmRequest.config.tools` holds `[{googleSearch: {}}]`.

`adk-js` has no managed agent yet, so nothing in the framework sets the flag
today. Set it yourself if you build a managed request in your own host.

## Failure modes

`processLlmRequest` throws in two cases:

- The request names a model that is not Gemini, and neither the environment
  variable nor `isManagedAgent` applies. The message is `Google search tool is
not supported for model <model>`.
- The request names a Gemini 1.x model, already carries another tool, and
  `bypassMultiToolsLimit` is false. The message is `Google search tool can not
be used with other tools in Gemini 1.x.`

Calling the tool as a function does not throw. `BuiltInTool.runAsync` returns an
error payload telling the model the tool runs inside the model.
