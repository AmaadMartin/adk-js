# OpenAIResponsesLlm

`OpenAIResponsesLlm` runs an ADK agent on a GPT model through the OpenAI
Responses API. Reach for it instead of `OpenAILlm` when you want reasoning
effort, encrypted reasoning replay, or server-side response storage, none of
which the Chat Completions API exposes.

## Introduction

The Responses API is OpenAI's newer surface. It takes a list of typed input
items rather than a list of chat messages, it returns a list of output items
rather than one message, and it adds three things ADK can use: a `reasoning`
block, `previous_response_id` for server-side continuity, and reasoning items
that carry encrypted content.

`OpenAIResponsesLlm` maps between those items and the genai types ADK works in.
A thinking config becomes `reasoning`, function declarations become Responses
function tools, tool results replay as `function_call_output` items, and a
reasoning item comes back as a `Part` with `thought: true`.

Unlike `OpenAILlm`, this class registers **no** model pattern, matching
adk-python. A model string such as `'gpt-5'` therefore resolves to `OpenAILlm`,
not to this class. Pass an instance to use the Responses API.

The `openai` package is an optional peer dependency. ADK does not install it,
and `import '@google/adk'` never loads it. The first call to the model imports
it and reports what to install if it is absent.

Text generation, function calling, structured output and reasoning are
supported, in both the non-streaming and the streaming mode. The live API is
not: `connect()` rejects.

## Get started

Install the SDK and set `OPENAI_API_KEY`. The default client reads the key from
the environment.

```bash
npm install openai
echo "OPENAI_API_KEY=your-api-key-here" > .env
```

Define the agent in `agent.ts`:

```ts
import {LlmAgent, OpenAIResponsesLlm} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'assistant',
  model: new OpenAIResponsesLlm({model: 'gpt-5'}),
  instruction: 'You are a concise assistant.',
});
```

Run it:

```bash
npx @google/adk-devtools run agent.ts
```

`samples/models/openai_responses/agent.ts` is the same agent with a tool
attached.

## Options

Every option is optional.

| Option                    | Default         | Meaning                                                                         |
| ------------------------- | --------------- | ------------------------------------------------------------------------------- |
| `model`                   | `gpt-5`         | The model to call.                                                              |
| `apiKey`                  | the environment | A key, or a synchronous callable returning one.                                 |
| `client`                  | the SDK default | A pre-configured client.                                                        |
| `store`                   | the API default | Whether the API stores the response for later retrieval.                        |
| `include`                 | the API default | Extra output to return, e.g. `'reasoning.encrypted_content'`.                   |
| `reasoning`               | unset           | Reasoning used when the request carries no thinking config.                     |
| `parallelToolCalls`       | the API default | Whether the model may emit several tool calls at once.                          |
| `truncation`              | the API default | `'auto'` or `'disabled'`.                                                       |
| `serviceTier`             | the API default | The latency tier to bill at.                                                    |
| `includeResponseMetadata` | `true`          | Whether to attach the raw response to `LlmResponse.customMetadata`.             |
| `extraRequestArgs`        | `{}`            | Extra request fields, applied last, for an API field this SDK does not declare. |

`apiKey` accepts a callable so a key can be fetched from a secret store at call
time. It must be synchronous; an async provider throws a `TypeError` rather
than sending a promise to the SDK as the key.

## Reasoning

A request's `thinkingConfig` maps onto the Responses `reasoning` block, so an
agent written for Gemini thinking runs unchanged.

| `thinkingConfig`                           | `reasoning`                               |
| ------------------------------------------ | ----------------------------------------- |
| `thinkingLevel: MINIMAL / LOW / HIGH`      | that effort, with `summary: 'concise'`    |
| `thinkingLevel: MEDIUM` or unspecified     | `{effort: 'medium', summary: 'concise'}`  |
| `thinkingBudget: 0`                        | `{effort: 'minimal', summary: 'concise'}` |
| any other `thinkingBudget`, including `-1` | `{effort: 'medium', summary: 'concise'}`  |
| absent                                     | the `reasoning` option, if one was set    |

A `thinkingConfig` that sets neither a level nor a budget throws, because
Responses reasoning is effort-based and there is no defensible effort to guess.
`thinkingLevel` wins over `thinkingBudget`.

Reasoning comes back as parts with `thought: true`. When the response carries
encrypted reasoning, each part also carries it as `thoughtSignature`, and a
redacted item with no summary still produces one signature-only part.

Reasoning is **not replayed** into a later request. Responses reasoning input
items must reference a reasoning item id from a prior response, ADK thought
parts do not carry one, and the API rejects a synthetic id. Set
`previousInteractionId` on the request for server-side continuity instead.

## Structured output

`responseSchema` or `responseJsonSchema` becomes a strict `json_schema` text
format. The schema is rewritten into the subset OpenAI's strict mode accepts:
every object forbids extra properties and lists all of its properties as
required. The format name comes from the schema's `title`, sanitized to
`^[a-zA-Z0-9_-]+$`, and defaults to `schema`.

```ts
import {LlmAgent, OpenAIResponsesLlm} from '@google/adk';
import {z} from 'zod';

export const rootAgent = new LlmAgent({
  name: 'extractor',
  model: new OpenAIResponsesLlm({model: 'gpt-5'}),
  outputSchema: z.object({city: z.string(), degrees: z.number()}),
});
```

With no schema, `responseMimeType: 'application/json'` asks for
`{type: 'json_object'}` instead.

## Azure

`AzureOpenAIResponsesLlm` is the same model against Azure's OpenAI-compatible
`/openai/v1/responses` endpoint. `model` is the deployment name, and the key
falls back to `AZURE_OPENAI_API_KEY`.

```ts
import {AzureOpenAIResponsesLlm} from '@google/adk';

const model = new AzureOpenAIResponsesLlm({
  model: 'my-gpt-5-deployment',
  azureEndpoint: 'https://my-resource.openai.azure.com',
});
```

The base URL is the endpoint with trailing slashes stripped, plus
`/openai/v1/`.

## Response metadata

With `includeResponseMetadata` left at `true`, every `LlmResponse` carries
`customMetadata.openai_response`, holding the response id, its status, its
output items, and the usage, reasoning and unmapped-output blocks when there
are any. Set it to `false` to keep responses small; usage still arrives as
`usageMetadata`.

While streaming, the model also emits a boundary response when a reasoning
stream closes, carrying
`customMetadata.openai_response.stream_event.reasoning_done`. It tells a
consumer where one reasoning item stopped, which the text deltas alone do not
say. `includeResponseMetadata: false` suppresses it.

## Failure modes

- **The `openai` package is missing.** The first call throws an error naming the
  package, the feature, and the `npm install` command.
- **A tool call's arguments are not valid JSON.** The model still yields the
  function-call part, with empty arguments, and logs the failure at warn level.
- **The response is `incomplete`, `failed` or `cancelled`.** Nothing throws. The
  `LlmResponse` carries `finishReason`, `errorCode` and, when the API explained
  itself, `errorMessage`. Running out of output tokens maps to `MAX_TOKENS`.
- **The stream fails.** The model yields one terminal error response and no
  final response.
- **Media in an assistant turn.** The Responses API has no representation for
  it, so the part is dropped and the drop is logged at warn level.
- **`connect()`.** It rejects. Use a Gemini live model for bidirectional
  streaming.
