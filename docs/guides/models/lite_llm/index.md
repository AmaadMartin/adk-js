# LiteLlm

`LiteLlm` runs an ADK agent on a model that speaks the OpenAI chat-completions
protocol. Reach for it when the model you want is not a Gemini model: Claude,
GPT, Llama, Mistral, DeepSeek, or anything a LiteLLM Proxy deployment fronts.

## Introduction

Every other model class in `@google/adk` terminates at a Gemini endpoint.
`Gemini` talks to the Gemini API or Vertex AI, `ApigeeLlm` puts an Apigee proxy
in front of the same API, and `RoutedLlm` picks between models you already
have. None of them speaks another provider's protocol, so an agent that needs
Claude has nothing to construct.

`LiteLlm` fills that gap by speaking one protocol — OpenAI chat completions —
that almost every provider and gateway implements. It converts an `LlmRequest`
into a chat-completions request, sends it, and converts the response back into
`LlmResponse` objects. Roles, multimodal parts, tool declarations, tool
results, structured output, generation parameters, usage metadata, finish
reasons and streaming aggregation are all handled by the conversion.

Provider routing is not. `LiteLlm` does not know that
`anthropic/claude-sonnet-4` is served by Anthropic, and it holds no
per-provider credentials. The endpoint you point it at decides that. A
[LiteLLM Proxy](https://docs.litellm.ai/docs/simple_proxy) deployment is the
usual choice because it routes to any provider LiteLLM supports, but OpenAI,
Azure, Groq, Together, Ollama and vLLM all serve the same protocol directly.

The transport itself is an interface, `LiteLlmClient`. The built-in
implementation is a `fetch` POST; supplying your own is how you sign requests,
route through an SDK, or run an agent's logic in a test with no network.

## Get started

Point `LiteLlm` at an endpoint and give it to an agent.

```ts
import {InMemoryRunner, LiteLlm, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'assistant',
  model: new LiteLlm({
    model: 'anthropic/claude-sonnet-4',
    apiBase: 'http://localhost:4000/v1',
    apiKey: process.env['LITELLM_API_KEY'],
  }),
  instruction: 'You are a helpful assistant.',
});

const runner = new InMemoryRunner({agent, appName: 'assistant'});
const session = await runner.sessionService.createSession({
  appName: 'assistant',
  userId: 'user',
});

let answer = '';
for await (const event of runner.runAsync({
  userId: 'user',
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'Say hello.'}]},
})) {
  answer += event.content?.parts?.[0]?.text ?? '';
}
```

`answer` now holds the model's reply.

`model` is sent to the endpoint verbatim, so it uses whatever naming that
endpoint expects — usually LiteLLM's `provider/model` form.

## Configuration

| Option           | Behaviour                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `model`          | The model name, sent verbatim. Required.                                                                                    |
| `apiBase`        | The endpoint base URL. Falls back to `LITELLM_API_BASE`. `/chat/completions` is appended unless the URL already ends in it. |
| `apiKey`         | Sent as `Authorization: Bearer <key>`. Falls back to `LITELLM_API_KEY`. A local Ollama or vLLM server needs none.           |
| `headers`        | Extra HTTP headers, sent beneath the ones the client sets itself.                                                           |
| `client`         | The transport. Defaults to the built-in `FetchLiteLlmClient`.                                                               |
| `additionalArgs` | Extra request fields, merged over the generated request.                                                                    |

`additionalArgs` is how you send anything the conversion does not generate, for
example `{temperature: 0.2}` or a provider-specific field your endpoint
understands. The four request fields `LiteLlm` owns — `model`, `messages`,
`tools` and `stream` — are dropped from it, so it cannot contradict the request
being built.

`config.httpOptions` on the request maps onto the request too: `headers`
becomes `extra_headers`, `retryOptions.attempts` becomes `num_retries`,
`extraBody` becomes `extra_body`, and `timeout` is converted from milliseconds
to the seconds the protocol uses.

The environment variables are only read by the built-in client, and only
outside a browser. Supplying your own `client` reads neither.

## Tools, structured output and streaming

Tools declared on the agent travel as chat-completions function tools, and the
model's tool calls come back as ADK function-call parts, so `FunctionTool`
works unchanged. A tool a provider serves natively, such as Google Search,
carries no function declarations and is forwarded to the endpoint as-is rather
than dropped.

`config.responseSchema` becomes a `response_format`. Gemini models reached
through LiteLLM get `{type: 'json_object', response_schema: ...}`; every other
model gets an OpenAI strict `json_schema`, with `additionalProperties: false`
and every property required, because strict mode demands both.

An output schema and tools work together on every route, so
`capabilities.outputSchemaAndTools` is always `true`:

```ts
new LiteLlm({model: 'openai/gpt-4o', apiBase}).capabilities;
// {outputSchemaAndTools: true}
```

LiteLLM reconciles the two per provider. A provider with native support gets
both passed through, and the rest get a JSON tool call with `tool_choice`
enforcement.

Streaming yields a `partial: true` response per text or reasoning delta,
followed by the aggregated response carrying the usage metadata, the finish
reason and any grounding metadata. Tool-call fragments are accumulated across
chunks, including providers that split one call's arguments over many deltas
or that give every parallel call the same index.

## Prompt caching

Set `cacheConfig` on the request and `LiteLlm` asks the endpoint to cache the
stable head of the prompt. It sends a `cache_control_injection_points` field
naming two places to mark: the system message, and the last message.

```ts
import {ContextCacheConfig, LiteLlm, LlmRequest} from '@google/adk';

const cacheConfig: ContextCacheConfig = {
  cacheIntervals: 10,
  ttlSeconds: 3600,
  minTokens: 4096,
};

const model = new LiteLlm({
  model: 'anthropic/claude-sonnet-4',
  apiBase: 'http://localhost:4000/v1',
});

const llmRequest: LlmRequest = {
  contents: [{role: 'user', parts: [{text: 'Summarise the contract.'}]}],
  liveConnectConfig: {},
  toolsDict: {},
  cacheConfig,
};

let answer = '';
for await (const response of model.generateContentAsync(llmRequest)) {
  answer += response.content?.parts?.[0]?.text ?? '';
}
```

The system message is the stable head of the prompt. The last message caches
the conversation so far, and moves forward on its own as the conversation
grows. A `ttlSeconds` of 3600 or more adds `ttl: '1h'` to both points, which
asks for the longest cache a provider offers. Anything shorter gets the
provider's default lifetime.

`minTokens` gates on the previous turn's measured prompt size, which the
request carries as `cacheableContentsTokenCount`. A prompt below that size
sends no injection points, because writing a cache for it costs more than it
saves. The first turn has no measured size, so it is always marked.

LiteLLM applies the points and then lets each provider decide. Claude honours
them. A provider that caches automatically, or not at all, has them dropped
before the request leaves. Naming your own `cache_control_injection_points` in
`additionalArgs` overrides all of this: you know your provider better than the
app-level config does.

## Tracking headers

A request to a Vertex AI or Gemini model carries `x-goog-api-client` and
`user-agent` headers that identify ADK to Google's usage pipeline. This covers
`vertex_ai/…`, `gemini/gemini-…`, and either of those behind a `litellm_proxy/`
prefix. No other provider gets them.

Your own value for one of those headers survives. The ADK labels come first and
yours is appended, with no label repeated.

## Thought signatures

A Gemini thinking model attaches a thought signature to each function call, and
the next turn has to send it back or the model's reasoning chain breaks.
`LiteLlm` carries the signature in both directions with no configuration.

On the way in, the signature arrives in one of four places depending on the
provider path, and `LiteLlm` reads whichever one carries it:
`extra_content.google` on the tool call, `provider_specific_fields` on the tool
call or on the function, or embedded in the tool call id after a `__thought__`
separator. It lands on the function-call `Part` as `thoughtSignature`. A
malformed signature is dropped and the tool call is still emitted.

On the way out, a `Part` carrying a `thoughtSignature` sends it as both
`provider_specific_fields` and `extra_content.google` on the tool call, because
LiteLLM's Gemini prompt conversion reads the first and the OpenAI-compatible
endpoint reads the second. See
[the Gemini thought-signature documentation](https://ai.google.dev/gemini-api/docs/thought-signatures).

## Supplying your own client

`LiteLlmClient` has two methods, one per mode. Implementing it replaces the
transport without touching any of the conversion.

```ts
import {
  CompletionArgs,
  LiteLlm,
  LiteLlmClient,
  ModelResponse,
  ModelResponseStream,
} from '@google/adk';

class EchoClient implements LiteLlmClient {
  async completion(args: CompletionArgs): Promise<ModelResponse> {
    const last = args.messages[args.messages.length - 1];
    return {
      model: args.model,
      choices: [
        {
          message: {role: 'assistant', content: `You said: ${last.content}`},
          finish_reason: 'stop',
        },
      ],
    };
  }

  async streamCompletion(
    args: CompletionArgs,
  ): Promise<AsyncIterable<ModelResponseStream>> {
    const response = await this.completion(args);
    return (async function* () {
      yield response;
    })();
  }
}

const model = new LiteLlm({model: 'openai/gpt-4o', client: new EchoClient()});
```

A custom client needs no `apiBase`: the base URL belongs to the built-in
client, and nothing else reads it.

## Failure modes

| Condition                                                        | Behaviour                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| No base URL and no custom client                                 | The constructor throws, naming `apiBase` and `LITELLM_API_BASE`.                         |
| The endpoint answers with a non-2xx status                       | The call throws, naming the model, the status and the start of the response body.        |
| A content part carries a MIME type the protocol has no block for | The call throws, naming the MIME type.                                                   |
| A file URI the provider cannot resolve, or one with no MIME type | The call throws. The URI is redacted first, so a signed URL is never put in the message. |
| A tool call in the history was never answered                    | A placeholder tool result is inserted and a warning is logged. The call proceeds.        |
| The model stops for a reason other than a clean stop             | The response carries `finishReason`, `errorCode` and `errorMessage`. Nothing is thrown.  |

A provider that reports its token counts in an unusual way is read anyway.
`usage` is accepted as an object or as a JSON string, and a count that is not a
number is ignored rather than coerced, so `usageMetadata` reports `0` instead
of failing the call. A streamed response is the one exception: a chunk whose
`usage` is neither absent nor an object throws
`Unexpected LiteLLM usage type`, because a stream that reports usage in an
unreadable shape has nothing else left to give.

`LiteLlm` has no live connection: `connect()` throws. Use `Gemini` for live
sessions.

`LiteLlm` is also not registered with `LLMRegistry`, even though
`LiteLlm.supportedModels` declares the provider prefixes it handles. The
registry constructs a model from its name alone, which cannot supply an
endpoint, so a registry-built instance would have nowhere to send requests.
Construct it explicitly and pass the instance to the agent.
