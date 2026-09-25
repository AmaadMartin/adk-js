# Models

`Claude` and `LiteLlm` let an `LlmAgent` run on a model that is not Gemini.
`Claude` calls Anthropic's Claude models served on Vertex AI. `LiteLlm` calls
any server that speaks the OpenAI chat-completions protocol, such as a LiteLLM
proxy, OpenAI, or a local model server, through a client you supply. Both are
`BaseLlm` subclasses, so an agent, its tools and its instruction do not change
when you swap one in for `Gemini`.

## Introduction

An `LlmAgent` talks to its model through `BaseLlm`: the framework builds an
`LlmRequest` of Gemini-shaped `Content`, a `GenerateContentConfig` and the
agent's tools, and reads back `LlmResponse` objects. A model class translates
between that shape and its provider's wire format in both directions. That
translation is all `Claude` and `LiteLlm` do, which is why the rest of the
agent is unaffected by the choice.

Pick `Claude` when the model you want is Claude 3 and you already use Vertex
AI, because the class needs nothing beyond a Google Cloud project and
application default credentials. Pick `LiteLlm` when the model sits behind an
OpenAI-compatible endpoint, or when you want one class that reaches many
providers through a LiteLLM proxy. Keep `Gemini` for Gemini models, because it
is the only one of the three that supports live connections and fills in
response metadata such as `usageMetadata` and `finishReason`. Of the two
classes here, `LiteLlm` streams and `Claude` does not.

## Get started

This example builds one agent that runs on either class. Only the object
passed as `model` changes between the two.

```ts
import {Claude, FunctionTool, LiteLlm, LlmAgent} from '@google/adk';
import {z} from 'zod';

const rollDie = new FunctionTool({
  name: 'roll_die',
  description: 'Roll a die and return the rolled result.',
  parameters: z.object({sides: z.number().int()}),
  execute: ({sides}) => Math.floor(Math.random() * sides) + 1,
});

// Claude on Vertex AI. Reads GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION.
export const claudeAgent = new LlmAgent({
  name: 'dice_agent',
  model: new Claude({model: 'claude-3-5-sonnet-v2@20241022'}),
  instruction: 'Roll dice with the roll_die tool.',
  tools: [rollDie],
});

// Any OpenAI-compatible server, through a client you write.
export const liteLlmAgent = new LlmAgent({
  name: 'dice_agent',
  model: new LiteLlm({model: 'gpt-4o', llmClient: myChatCompletionsClient}),
  instruction: 'Roll dice with the roll_die tool.',
  tools: [rollDie],
});
```

`myChatCompletionsClient` is an object implementing `LiteLlmClient`. The
section on `LiteLlm` below shows what it has to do, and the sample linked at
the end ships a complete one built on `fetch`.

## How it works

Every call follows the same three steps, whichever class handles it:

1. The model class converts `llmRequest.contents` into provider messages, the
   system instruction into the provider's system slot, and the function
   declarations of the first entry in `llmRequest.config.tools` into provider
   tool definitions.
2. It sends the request and waits for the reply.
3. It converts the reply back into `LlmResponse` objects whose `content.role`
   is `'model'` and whose parts are text or `functionCall` parts. The agent
   then runs any requested tools and sends their `functionResponse` parts back
   on the next turn.

### What each class converts

The two classes translate the same Gemini parts, but not all of them. The
table lists what reaches the provider for each part a request can carry.

| Gemini input                     | `Claude` sends                                                                      | `LiteLlm` sends                                                     |
| :------------------------------- | :---------------------------------------------------------------------------------- | :------------------------------------------------------------------ |
| `role: 'model'` or `'assistant'` | `assistant`                                                                         | `assistant`                                                         |
| any other role                   | `user`                                                                              | `user`                                                              |
| text part                        | a `text` block                                                                      | the string itself when it is the only part, otherwise a `text` item |
| `functionCall` part              | a `tool_use` block with the call's `id`, `name` and `args`                          | a `tool_calls` entry whose `arguments` is the JSON of `args`        |
| `functionResponse` part          | a `tool_result` block holding `response.result`, JSON-encoded unless it is a string | a `tool` message holding the JSON of the whole `response`           |
| image or video `inlineData`      | not supported, throws `Not supported yet.`                                          | an `image_url` or `video_url` data URI                              |
| other `inlineData`               | not supported, throws `Not supported yet.`                                          | throws `LiteLlm(BaseLlm) does not support this content part.`       |
| system instruction               | the `system` parameter, as text                                                     | a leading `developer` message, as text                              |

A `Content` whose first part is a `functionResponse` becomes a single `tool`
message in `LiteLlm`, and the remaining parts of that `Content` are not sent.
Claude converts every part.

A system instruction given as `Content` or as a list of parts is flattened to
text before either class sends it: the text of each part, joined by newlines.
Non-text parts in a system instruction contribute nothing.

### Tool schemas

Gemini schemas name their types in upper case, `STRING` or `INTEGER`, and both
providers expect JSON Schema's lower-case names, so both classes lower-case the
`type` field.

`LiteLlm` lower-cases `type` at every level of the schema, including array
`items` and nested `properties`, and it copies the declaration's top-level
`required` list into the tool parameters. `Claude` lower-cases only the `type`
of each top-level property and sends no `required` list, so nested object and
array types keep Gemini's upper-case names. A model generally still calls a
Claude tool correctly, but the schema it reads is less precise than the one
`LiteLlm` sends.

Only the first `Tool` in `config.tools` contributes declarations. A function
tool adds its declaration to the first entry that already holds declarations,
or appends a new entry when there is none. The declarations are therefore lost
when some other entry comes first, such as a built-in tool listed before the
function tools, or when you build an `LlmRequest` yourself.

## Claude

`Claude` sends each request to the Anthropic Messages API on Vertex AI through
the `@anthropic-ai/vertex-sdk` client.

### Credentials

The client is created on the first request, not in the constructor, so
constructing a `Claude` never fails for missing configuration. The first
`generateContentAsync` call throws
`GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set for using Anthropic on Vertex.`
when either environment variable is unset. The Vertex client then
authenticates with application default credentials. The Claude model must be
enabled in that project and region.

### Requests and responses

Each call sends one request with `max_tokens` set to `MAX_TOKEN`, which is
`1024`, and yields exactly one `LlmResponse`. The request's `model` is
`llmRequest.model` when the framework set one, and the instance's `model`
otherwise.

When the request carries tools, `Claude` sets `tool_choice` to
`{type: 'auto', disable_parallel_tool_use: true}`. The model can therefore
call at most one tool per turn, so an agent that needs two tool results takes
two turns to get them.

The returned `LlmResponse` carries `content` only. `finishReason`,
`usageMetadata` and the other `LlmResponse` fields stay undefined, because the
port does not map them. A reply containing a content block other than `text` or
`tool_use` throws `Not supported yet.`

`generateContentAsync` accepts a third `abortSignal` argument and passes it to
the Anthropic client, so aborting the signal cancels the HTTP request.

### Registering Claude by name

`Claude` is not in `LLMRegistry` by default, so a string such as
`model: 'claude-3-5-sonnet-v2@20241022'` on an agent throws
`Model claude-3-5-sonnet-v2@20241022 not found.` Pass an instance, or register
the class once so that strings matching `claude-3-.*` resolve to it:

```ts
import {Claude, LLMRegistry, LlmAgent} from '@google/adk';

LLMRegistry.register(Claude);

const agent = new LlmAgent({
  name: 'assistant',
  model: 'claude-3-5-haiku@20241022',
});
```

## LiteLlm

`LiteLlm` converts the request into chat-completions messages and tools, and
hands the result to the `LiteLlmClient` you pass in. The class performs no
network I/O itself, which keeps the transport, the authentication and the
endpoint in your code.

### Writing a LiteLlmClient

A client implements two methods. `acompletion` answers a non-streaming request
with one `ModelResponse`. `completion` answers a streaming request with an
`AsyncIterable` of `ModelResponse` chunks, one per server-sent event. Both
receive a `CompletionRequest`:

| Field            | Type                                | Content                                                                                      |
| :--------------- | :---------------------------------- | :------------------------------------------------------------------------------------------- |
| `model`          | `string`                            | The `LiteLlm` instance's `model`.                                                            |
| `messages`       | `ChatCompletionMessage[]`           | The converted conversation, led by a `developer` message when there is a system instruction. |
| `tools`          | `ChatCompletionTool[] \| undefined` | The converted function declarations, or `undefined` when there are none.                     |
| `stream`         | `boolean \| undefined`              | `true` on a request passed to `completion`, absent on one passed to `acompletion`.           |
| `additionalArgs` | `Record<string, unknown>`           | The constructor's `additionalArgs`, for the client to merge into the body.                   |

This client sends the request to an OpenAI-compatible endpoint with `fetch`.
It merges `additionalArgs` into the body, because the chat-completions API
expects those settings at the top level:

```ts
import type {
  CompletionRequest,
  LiteLlmClient,
  ModelResponse,
} from '@google/adk';

class ChatCompletionsClient implements LiteLlmClient {
  constructor(private readonly baseUrl: string) {}

  async acompletion(request: CompletionRequest): Promise<ModelResponse> {
    const {additionalArgs, ...body} = request;
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({...body, ...additionalArgs}),
    });
    return (await response.json()) as ModelResponse;
  }

  async *completion(request: CompletionRequest): AsyncIterable<ModelResponse> {
    // Parse the server-sent events of a streamed response; see the sample.
  }
}
```

`LiteLlm` reads a tool call only when its `type` is `'function'`. OpenAI sends
`type` on the first streamed delta of each tool call and omits it on the
deltas that carry the rest of the arguments, so a streaming client has to set
`type: 'function'` on every delta for the arguments to be reassembled.

### Streaming

`generateContentAsync(llmRequest, stream)` takes the path the framework asks
for. The framework passes `stream: true` when the run's `streamingMode` is
`StreamingMode.SSE`.

- **Not streaming.** `LiteLlm` calls `acompletion` and yields one response. A
  response without `choices[0].message` throws `No message in response`.
- **Streaming.** `LiteLlm` calls `completion` and yields an `LlmResponse` with
  `partial: true` for each text delta. When a chunk arrives with
  `finish_reason: 'stop'`, it yields one more response holding the full text
  with `partial: false`. Tool-call deltas are accumulated and yielded as one
  function-call response when a chunk arrives with
  `finish_reason: 'tool_calls'`.

The streaming path accumulates a single tool call at a time: the name and
arguments of every tool-call delta before the `tool_calls` finish reason are
concatenated. A model that streams two tool calls in one turn therefore yields
one call with both names and both argument strings run together. Use the
non-streaming path with models that make parallel tool calls.

## Configuration options

### ClaudeParams

The constructor takes an optional object, and `new Claude()` is valid.

| Option  | Type     | Default                           | Description                         |
| :------ | :------- | :-------------------------------- | :---------------------------------- |
| `model` | `string` | `'claude-3-5-sonnet-v2@20241022'` | The Claude model name on Vertex AI. |

`Claude.supportedModels` is `[/claude-3-.*/]`, which is what
`LLMRegistry.register(Claude)` matches against.

### LiteLlmParams

| Option           | Type                      | Default | Description                                                                                 |
| :--------------- | :------------------------ | :------ | :------------------------------------------------------------------------------------------ |
| `model`          | `string`                  | none    | Required. The model name the client sends, for example `openai/gpt-4o` for a LiteLLM proxy. |
| `llmClient`      | `LiteLlmClient`           | none    | Required. The client that sends each request.                                               |
| `additionalArgs` | `Record<string, unknown>` | `{}`    | Extra arguments passed to the client on every request, such as `temperature`.               |

`additionalArgs` entries named `messages`, `tools` or `stream` are dropped when
the instance is constructed, because `LiteLlm` sets those three itself on each
request.

`LiteLlm.supportedModels` is empty, and the constructor needs a client, so
`LiteLlm` cannot be resolved from a model string through `LLMRegistry`. Pass an
instance.

## Limitations

- **No live connections.** `connect` throws on both classes, so neither works
  with `runLive` or bidirectional streaming.
- **Claude does not stream.** `Claude` ignores the `stream` argument and
  yields one complete response, even when the run uses `StreamingMode.SSE`.
- **Claude sends text, function calls and function responses only.** An image
  or other `inlineData` part in the conversation throws `Not supported yet.`
- **Claude caps every reply at 1,024 tokens.** `MAX_TOKEN` is not
  configurable, and a longer answer is truncated by the model.
- **Neither class reports usage or finish reason.** `usageMetadata` and
  `finishReason` stay undefined on every `LlmResponse`, so token accounting and
  truncation detection that read those fields see nothing.
- **Only the first `Tool` entry is read.** Declarations in any later entry of
  `config.tools`, and built-in tools such as Google Search, are not sent.

## Related samples

- [`samples/models/`](../../../samples/models/README.md) - One agent that runs on `LiteLlm` against any OpenAI-compatible server or on `Claude` on Vertex AI, with a complete `fetch`-based `LiteLlmClient` that handles streaming.
