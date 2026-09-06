# OpenAI Responses models

`OpenAiResponsesLlm` runs an ADK agent on an OpenAI model through the Responses
API. `AzureOpenAiResponsesLlm` runs the same agent against an Azure OpenAI
deployment. Reach for them when you want a GPT model behind the same `LlmAgent`
code that runs Gemini.

## Introduction

Both classes are `BaseLlm` implementations, so an agent uses them the way it
uses `Gemini`. They differ only in where the request goes and how it is
authenticated.

The Responses API is OpenAI's stateful successor to chat completions. It takes
a list of typed input items rather than a list of chat messages, it returns
reasoning as its own output item, and it can chain a turn onto the previous one
by id. ADK maps its own request onto that shape: `Content` becomes input items,
a `FunctionDeclaration` becomes a function tool, and
`LlmRequest.previousInteractionId` becomes `previous_response_id`. Coming back,
message text, refusals, reasoning summaries and function calls become ADK
`Part`s.

Neither class is registered with `LLMRegistry`. A model name string never
resolves to one, so pass an instance as an agent's `model`. Both are marked
experimental and warn once when you construct them.

`openai` is an optional peer dependency. Installing `@google/adk` does not
download it, and ADK loads it only when a model first needs a client you did
not supply:

```
npm install openai
```

## Get started

Set `OPENAI_API_KEY` to a key from the OpenAI platform, then:

```ts
import {InMemoryRunner, LlmAgent, OpenAiResponsesLlm} from '@google/adk';

const agent = new LlmAgent({
  name: 'assistant',
  model: new OpenAiResponsesLlm({model: 'gpt-5'}),
  instruction: 'You are a concise assistant.',
});

const runner = new InMemoryRunner({agent, appName: 'openai_app'});
const session = await runner.sessionService.createSession({
  appName: 'openai_app',
  userId: 'u1',
});

for await (const event of runner.runAsync({
  userId: 'u1',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'Name three primary colours.'}]},
})) {
  console.log(event.content?.parts?.[0]?.text);
}
```

`model` defaults to `gpt-5`. A model name on the request itself wins over the
one on the instance, so a single model object can serve several agents.

## Azure OpenAI

Azure exposes the Responses API through an OpenAI-compatible
`/openai/v1/responses` endpoint on the resource. Give the resource endpoint and
name your deployment as the model:

```ts
import {AzureOpenAiResponsesLlm} from '@google/adk';

const llm = new AzureOpenAiResponsesLlm({
  model: 'my-deployment',
  azureEndpoint: 'https://example.openai.azure.com/',
});
```

The key comes from `apiKey` if you set one, and from `AZURE_OPENAI_API_KEY`
otherwise.

## Credentials

`apiKey` takes a string, or a function returning one. The function runs once,
when the client is built, so a key fetched from a secret store does not have to
be resolved before the agent is constructed. An `async` function works too:

```ts
import {OpenAiResponsesLlm} from '@google/adk';

declare function fetchKeyFromSecretStore(): Promise<string>;

const llm = new OpenAiResponsesLlm({
  model: 'gpt-5',
  apiKey: () => fetchKeyFromSecretStore(),
});
```

With no `apiKey`, the `openai` package resolves the credential itself, which
means `OPENAI_API_KEY`.

## Bring your own client

Pass a `client` to reach an OpenAI-compatible host, or to set an organization,
a base URL, a timeout, a retry policy or custom headers. ADK then never
constructs a client of its own, and never reads `apiKey`:

```ts
import {OpenAiResponsesLlm} from '@google/adk';
import OpenAI from 'openai';

const llm = new OpenAiResponsesLlm({
  model: 'my-model',
  client: new OpenAI({baseURL: 'https://my-host.example/v1', maxRetries: 5}),
});
```

The `client` option is typed as `OpenAiResponsesClient`, a structural interface
covering only `responses.create`, so a test double satisfies it as well.

## Reasoning

`thinkingConfig` on the request decides the reasoning effort, and overrides the
`reasoning` option on the instance. The Responses API is effort-based rather
than token-budget based, so a budget is mapped rather than passed through:

| Request config                      | OpenAI receives                           |
| ----------------------------------- | ----------------------------------------- |
| no `thinkingConfig`                 | the instance's `reasoning`, if set        |
| `thinkingLevel`                     | that level, lowercased                    |
| `thinkingBudget: 0`                 | `{effort: 'minimal', summary: 'concise'}` |
| any other `thinkingBudget`          | `{effort: 'medium', summary: 'concise'}`  |
| `thinkingConfig` with neither field | throws                                    |

A mapped level always asks for a concise summary, so reasoning arrives as ADK
thought parts. To ask for the encrypted reasoning payload as well, add it to
`include`:

```ts
const llm = new OpenAiResponsesLlm({
  model: 'gpt-5',
  include: ['reasoning.encrypted_content'],
});
```

ADK stores that payload on the thought part as a base64 `thoughtSignature`. It
does not replay a stored thought back to the API: a Responses reasoning input
item must reference a reasoning item id from a real prior response, so
continuity runs through `previousInteractionId` instead.

## Structured output

`responseSchema` and `responseJsonSchema` become a `json_schema` text format
with `strict: true`. ADK forbids additional properties and marks every property
required, because OpenAI's strict mode demands both. The format name comes from
the schema's `title`, with anything outside `[a-zA-Z0-9_-]` replaced by an
underscore.

```ts
import {GenerateContentConfig, Type} from '@google/genai';

const config: GenerateContentConfig = {
  responseSchema: {
    title: 'Answer',
    type: Type.OBJECT,
    properties: {answer: {type: Type.STRING}},
  },
};
```

Setting `responseMimeType: 'application/json'` on its own asks for the older
JSON mode instead.

## Response metadata

Each `LlmResponse` carries the raw reply under
`customMetadata.openai_response`: the response id, its status, every output
item, and the usage, reasoning and unmapped-output blocks when the reply has
them. The keys stay snake_case because they are the payload OpenAI sent. Set
`includeResponseMetadata: false` to drop the block.

Streaming yields a partial response per text or reasoning delta, and one final
response. When a run of reasoning deltas ends, ADK yields a content-less
partial whose `customMetadata.openai_response.stream_event` marks the boundary,
so a consumer can tell where the reasoning stopped. That marker is part of the
metadata block and disappears with it.

## Unmodelled request fields

`extraRequestArgs` is merged into the request body last, so it overrides
anything ADK computed. Use it for Responses parameters these classes do not
model:

```ts
const llm = new OpenAiResponsesLlm({
  model: 'gpt-5',
  extraRequestArgs: {prompt_cache_key: 'my-prefix'},
});
```

## What is not supported

`connect()` rejects: neither class speaks the live bidirectional API.

An assistant turn carrying inline data or a file reference drops that media
with a warning, because the Responses API takes media only on an input turn.

Errors from the `openai` package propagate unchanged. The SDK already retries
with backoff, so ADK adds no retry loop of its own.
