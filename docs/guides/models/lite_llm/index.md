# LiteLlm

`LiteLlm` is a `BaseLlm` that speaks the OpenAI Chat Completions protocol.
Reach for it to run an agent on a model that is not Gemini: GPT, Claude, Llama,
Mistral, or a model you host yourself.

## Introduction

ADK for TypeScript ships `Gemini`, `ApigeeLlm` and `RoutedLlm`. All three talk
to Gemini. `LiteLlm` covers everything else, because almost every model server
now exposes the OpenAI Chat Completions endpoint. One class therefore serves a
LiteLLM proxy, OpenAI, Ollama, vLLM, LM Studio, Together, Groq, Fireworks, and
Anthropic's OpenAI-compatible endpoint.

`LiteLlm` translates in both directions. It converts `Content` and
`FunctionDeclaration` from `@google/genai` into chat-completions messages and
tools, then converts the reply back into `LlmResponse` objects. Tool calls
survive the round trip, so a `FunctionTool` works the same as it does on Gemini.

To reach a provider that does not speak the OpenAI protocol, run the LiteLLM
proxy in front of it (`litellm --model anthropic/claude-sonnet-4`) and point
`apiBase` at the proxy. Construct the instance yourself and hand it to the
agent: a base URL is always required, so a bare model name such as `gpt-4o`
never resolves to `LiteLlm`.

## Get started

This agent talks to a local Ollama server, which needs no key.

```ts
import {Event, InMemoryRunner, LiteLlm, LlmAgent} from '@google/adk';
import {createUserContent} from '@google/genai';

const agent = new LlmAgent({
  name: 'assistant',
  model: new LiteLlm({
    model: 'llama3.1',
    apiBase: 'http://localhost:11434/v1',
  }),
});

const runner = new InMemoryRunner({agent, appName: 'demo'});
const session = await runner.sessionService.createSession({
  appName: 'demo',
  userId: 'user',
});

const events: Event[] = [];
for await (const event of runner.runAsync({
  userId: 'user',
  sessionId: session.id,
  newMessage: createUserContent('Say hello.'),
})) {
  events.push(event);
}

// The last event carries the model's answer.
const answer = events.at(-1)?.content?.parts?.[0]?.text;
```

## Configuration

| Option           | Behaviour                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `model`          | Sent verbatim as the request `model`. A `provider/model` string passes through untouched, so the proxy resolves it.            |
| `apiBase`        | Base URL of the server. Falls back to `LITELLM_API_BASE`. `/chat/completions` is appended unless the URL already ends with it. |
| `apiKey`         | Sent as `Authorization: Bearer <apiKey>`. Falls back to `LITELLM_API_KEY`. A local server needs no key.                        |
| `headers`        | Merged into every request, beneath `Content-Type` and `Authorization`.                                                         |
| `additionalArgs` | Merged into the request body, for example `temperature` or `max_tokens`.                                                       |

`apiBase` is the one required setting. The constructor throws when neither the
option nor `LITELLM_API_BASE` is set, so a misconfigured agent fails at startup
rather than on its first turn.

`additionalArgs` cannot reach `model`, `messages`, `tools` or `stream`. The
constructor drops those four keys, because the class owns them.

```ts
const model = new LiteLlm({
  model: 'anthropic/claude-sonnet-4',
  apiBase: 'http://localhost:4000/v1',
  apiKey: process.env['LITELLM_MASTER_KEY'],
  additionalArgs: {temperature: 0.2},
});
```

## Streaming

Pass `stream: true` through the run config and `LiteLlm` reads the server-sent
event stream. It emits one partial `LlmResponse` per text delta, then one final
response that carries the whole text. Tool-call fragments accumulate until the
server reports the call, and the accumulator resets afterwards, so a stream
that contains two calls produces two complete calls.

An Anthropic-compatible server reports a tool call as `tool_use`; `LiteLlm`
renames it to `tool_calls` so both servers behave the same.

## Media

An `inlineData` part with an `image/*` or `video/*` MIME type is sent as a
data URI. Any other MIME type throws, and the error names the type. Inline
media bytes never reach the debug log, and neither does the API key.

## Failure modes

| Condition                              | Behaviour                                                           |
| -------------------------------------- | ------------------------------------------------------------------- |
| No `apiBase` and no `LITELLM_API_BASE` | The constructor throws.                                             |
| Non-2xx reply                          | Throws an error naming the model, the status and the response body. |
| Reply with no message                  | Throws `No message in response`.                                    |
| Unsupported inline media               | Throws an error naming the MIME type.                               |
| `connect()`                            | Rejects. `LiteLlm` has no live connection.                          |

`LiteLlm` does not retry. Use `RoutedLlm` when you want failover between
models.
