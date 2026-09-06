# OpenAI Responses models (experimental)

`OpenAIResponsesLlm` and `AzureOpenAIResponsesLlm` drive a GPT model through
the OpenAI **Responses** endpoint. Reach for them when you want an ADK agent to
run on a GPT model, on Azure OpenAI, or on any host that speaks the OpenAI
Responses API.

> [!WARNING]
> These models live under `core/src/labs/`. Everything in that folder is
> experimental and can change or be removed at any time without notice.

## Introduction

ADK talks to a model through `BaseLlm`: the model receives an `LlmRequest` and
yields `LlmResponse` objects. These two classes implement that interface on top
of `client.responses.create`, so the rest of ADK — tools, planners, sessions,
callbacks — works unchanged.

The Responses API is not the Chat Completions API. It keeps reasoning items in
the response, it addresses a prior turn by `previous_response_id` rather than by
replaying it, and it declares tools with top-level fields instead of nesting
them under `function`. The conversion in this module exists to hide those
differences behind the ADK request and response types.

Neither class is registered against a model name. `supportedModels` is empty on
both, matching adk-python, so a bare string like `'gpt-5'` never resolves to
them. Construct the model and assign the instance to the agent, as below.

Reasoning is effort-based here, not budget-based. A request that sets
`thinkingConfig.thinkingLevel` maps that level to an OpenAI effort. A request
that sets only `thinkingConfig.thinkingBudget` maps `0` to `minimal` effort and
any other budget to `medium`. A `thinkingConfig` with neither is rejected, so a
caller never silently gets an effort it did not choose.

## Get started

Install the SDK. ADK declares `openai` as an optional peer dependency, so
installing `@google/adk` does not download it:

```bash
npm install openai
```

Then build the model and hand it to an agent. The default client reads
`OPENAI_API_KEY` from the environment:

```ts
import {LlmAgent, OpenAIResponsesLlm} from '@google/adk';

const agent = new LlmAgent({
  name: 'assistant',
  model: new OpenAIResponsesLlm({model: 'gpt-5'}),
  instruction: 'You are a helpful assistant.',
});
```

A caller that never imports these classes never loads the `openai` package. A
caller that imports them without installing it gets an error naming the feature
and the install command, rather than a bare module-resolution failure.

## Configuration

The constructor takes the request fields ADK sends on every call:

| Option                    | Effect                                                        |
| ------------------------- | ------------------------------------------------------------- |
| `model`                   | The model to call. Defaults to `gpt-5`.                       |
| `apiKey`                  | A key, or a synchronous function returning one.               |
| `client`                  | A pre-configured client, used instead of building one.        |
| `store`                   | Whether OpenAI keeps the response for later retrieval.        |
| `include`                 | Extra output to return, e.g. `reasoning.encrypted_content`.   |
| `reasoning`               | Effort applied when the request states no preference.         |
| `parallelToolCalls`       | Whether the model may emit several tool calls per turn.       |
| `truncation`              | How OpenAI truncates an over-long conversation.               |
| `serviceTier`             | The tier to bill and schedule the request under.              |
| `includeResponseMetadata` | Keep the raw payload on `customMetadata`. Defaults to `true`. |
| `extraRequestArgs`        | Extra fields merged into every request body.                  |

`extraRequestArgs` overrides a computed field of the same name. An `extra_body`
entry inside it is flattened into the request body rather than sent as a field,
because `extra_body` is a request option of the Python SDK and has no Node
equivalent; the keys inside it reach the API exactly as they do from
adk-python. `config.stopSequences` is sent as the top-level `stop` field for
the same reason.

For anything the constructor does not expose — organization, timeout, retries,
custom headers, an OpenAI-compatible host — build the client yourself:

```ts
import {OpenAI} from 'openai';
import {OpenAIResponsesLlm} from '@google/adk';

const llm = new OpenAIResponsesLlm({
  model: 'my-model',
  client: new OpenAI({baseURL: 'https://my-host.example/v1', apiKey: '...'}),
});
```

Each model instance keeps its own client, so one process can talk to several
hosts. To send every request to one compatible host instead, leave `client`
unset and set `OPENAI_BASE_URL`, which the default client reads.

## Azure OpenAI

`AzureOpenAIResponsesLlm` points the client at an Azure resource. `model` is the
deployment name, and the key falls back to `AZURE_OPENAI_API_KEY`:

```ts
import {AzureOpenAIResponsesLlm} from '@google/adk';

const llm = new AzureOpenAIResponsesLlm({
  model: 'my-deployment',
  azureEndpoint: 'https://my-resource.openai.azure.com',
});
```

The endpoint is turned into the base URL
`https://my-resource.openai.azure.com/openai/v1/`.

## Streaming

Pass `stream: true` to `generateContentAsync` and the model yields partial
responses as they arrive: text deltas, thought deltas, and a metadata-only
marker at the point reasoning ends. A final, non-partial response follows,
built from the `response.completed` event when the API sends one and from the
accumulated events when it does not.

```ts
for await (const response of llm.generateContentAsync(request, true)) {
  if (response.partial) {
    process.stdout.write(response.content?.parts?.[0]?.text ?? '');
  }
}
```

A `response.failed` or `error` event ends the stream with one response carrying
`finishReason` and `errorCode` of `OTHER`, and no final response follows it.

## Failure modes

| Condition                                          | Behaviour                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| `openai` is not installed                          | An error naming the feature and `npm install openai`.                      |
| A tool declaration has no name                     | Throws; the API requires one.                                              |
| `thinkingConfig` sets neither a level nor a budget | Throws.                                                                    |
| An `apiKey` function returns a promise             | Throws; the key is resolved synchronously.                                 |
| The model sends malformed tool arguments           | Logs a warning and calls the tool with `{}`.                               |
| A response is `incomplete` or `failed`             | `errorCode` carries the finish reason and `errorMessage` the JSON payload. |
| `connect()`                                        | Throws; the Responses API has no bidirectional live mode.                  |

## Known limits

`responseSchema` accepts a Zod type, a genai `Schema`, or a plain JSON Schema.
The dialect is told apart by the case of the `type` names: genai writes
`OBJECT`, JSON Schema writes `object`. A schema that mixes the two in nested
subschemas is converted as whichever dialect its top-level `type` names.

A replayed thought part is dropped from the request. A Responses reasoning input
item has to reference a reasoning item id from a real prior response, ADK thought
parts do not carry one, and the API rejects a synthetic id. Continuity comes from
`previousInteractionId`, which ADK sends as `previous_response_id`.

Media in an assistant turn is dropped with a warning, because the Responses API
accepts image and file blocks only on user input.
