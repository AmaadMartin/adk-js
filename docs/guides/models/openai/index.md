# OpenAILlm

`OpenAILlm` runs an ADK agent on a GPT model through the OpenAI Chat
Completions API. Reach for it when you have an OpenAI API key, or when you want
to talk to a host that speaks the OpenAI wire format.

## Introduction

An `LlmAgent` names its model as a string or as a `BaseLlm` instance. Gemini is
the default, so an application that wants GPT needs a `BaseLlm` that speaks the
OpenAI protocol. `OpenAILlm` is that class. It converts the genai `Content` and
`FunctionDeclaration` types ADK works in into OpenAI messages and tools, calls
`chat.completions.create`, and converts the reply back.

The class registers itself with `LLMRegistry` for two model-name patterns,
`gpt-.*` and `o\d+-.*`. A bare string therefore works: `model: 'gpt-4o'`
resolves to `OpenAILlm` the same way `'gemini-3-pro-preview'` resolves to
`Gemini`.

The `openai` package is an **optional peer dependency**. ADK does not install
it, and `import '@google/adk'` never loads it. The first call to the model
imports it, and reports what to install if it is absent. Version 6 and version
7 both work. Version 7 requires Node.js 22 or newer, which is stricter than
ADK's own floor, so pin version 6 if you run Node.js 20.

Text generation and function calling are supported, in both the non-streaming
and the streaming mode. The live API is not: `connect()` rejects.

## Get started

Install the SDK and set `OPENAI_API_KEY`. The default client reads the key from
the environment.

```bash
npm install openai
echo "OPENAI_API_KEY=your-api-key-here" > .env
```

Define the agent in `agent.ts`:

```ts
import {LlmAgent, OpenAILlm} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'assistant',
  model: new OpenAILlm({model: 'gpt-4o'}),
  instruction: 'You are a concise assistant.',
});
```

Run it:

```bash
npx @google/adk-devtools run agent.ts
```

The model name alone also works, because the class is registered:

```ts
export const rootAgent = new LlmAgent({name: 'assistant', model: 'gpt-4o'});
```

`samples/models/openai/agent.ts` is the same agent with a tool attached.

## Options

Every option is optional.

| Option      | Default         | Meaning                                                                          |
| ----------- | --------------- | -------------------------------------------------------------------------------- |
| `model`     | `gpt-4o`        | The model to call.                                                               |
| `maxTokens` | `4096`          | The generated-token ceiling. A request that sets `maxOutputTokens` overrides it. |
| `client`    | the SDK default | A pre-configured client.                                                         |

## An OpenAI-compatible host

Build the client yourself and pass it as `client`. Each model instance keeps its
own client, so one process can talk to several hosts.

```ts
import OpenAI from 'openai';
import {OpenAILlm} from '@google/adk';

const llm = new OpenAILlm({
  model: 'my-model',
  client: new OpenAI({
    baseURL: 'https://my-host.example/v1',
    apiKey: process.env['MY_HOST_API_KEY'],
  }),
});
```

The SDK also reads `OPENAI_BASE_URL` from the environment, which redirects the
default client without any code change. ADK reads neither that variable nor
`OPENAI_API_KEY` itself; both belong to the SDK.

`client` is typed as `OpenAIClient`, a structural interface naming only
`chat.completions.create`. An `OpenAI` instance satisfies it, and so does a test
double.

## What the request carries

`OpenAILlm` maps the request's `config` onto the create parameters:

| Request field                                             | OpenAI parameter                                           |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `systemInstruction`                                       | a leading `system` message                                 |
| `tools[0].functionDeclarations`                           | `tools`, plus `tool_choice: 'auto'`                        |
| `responseSchema`                                          | a strict `json_schema` response format                     |
| `responseMimeType: 'application/json'`                    | `{type: 'json_object'}`, when there is no `responseSchema` |
| `temperature`, `topP`, `stopSequences`, `maxOutputTokens` | `temperature`, `top_p`, `stop`, `max_tokens`               |

Only the first entry of `tools` is read, matching adk-python.

The response carries `usageMetadata`, including `cachedContentTokenCount` when
the host reports `usage.prompt_tokens_details.cached_tokens`.

## Failure modes

- **The `openai` package is missing.** The first call throws an error naming the
  package, the feature, and the `npm install` command.
- **A tool call's arguments are not valid JSON.** The model still yields the
  function-call part, with empty arguments, and the failure is logged at warn
  level.
- **The API returns an error.** It propagates unchanged. The SDK client already
  retries with backoff; ADK adds no retry of its own.
- **`connect()`.** It rejects. Use a Gemini live model for bidirectional
  streaming.
