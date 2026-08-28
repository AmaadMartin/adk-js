# Anthropic Claude models

`AnthropicLlm` and `Claude` let an ADK agent talk to Anthropic's Claude models.
`AnthropicLlm` calls the Anthropic API directly. `Claude` calls the same models
served from Vertex AI. Reach for them when you want Claude instead of Gemini
and do not want to write your own `BaseLlm` subclass.

## Introduction

ADK resolves a model name through `LLMRegistry`, which maps name patterns to
`BaseLlm` subclasses. `Claude` is registered for `claude-3-*` and `claude-*-4*`,
so `model: 'claude-3-5-sonnet-v2@20241022'` resolves without any extra setup.
Pass an instance instead when you want the direct Anthropic API, or when you
want to set the token budget.

The two Anthropic SDKs are **optional peer dependencies**. ADK imports only
their types, and loads the package itself the first time you send a request.
Importing `@google/adk` therefore never pulls in an Anthropic package, and an
application that does not use Claude does not have to install one. A missing
package produces an error naming the feature and the `npm install` command.

The provider converts between genai types and Anthropic types on every turn:
text, thinking, redacted thinking, images, PDF documents, tool calls, tool
results, executable code, and code execution results. Tool declarations become
Anthropic tools, and JSON Schema types are lowercased because genai spells them
in upper case.

## Get started

Install the SDK for the client you want:

```sh
npm install @anthropic-ai/sdk          # the direct Anthropic API
npm install @anthropic-ai/vertex-sdk   # Claude on Vertex AI
```

Then name the model, or pass an instance:

```ts
import {AnthropicLlm, Claude, LlmAgent} from '@google/adk';

// Resolved through LLMRegistry to Claude on Vertex AI.
const byName = new LlmAgent({
  name: 'claude_agent',
  model: 'claude-3-5-sonnet-v2@20241022',
});

// The direct Anthropic API. The SDK reads ANTHROPIC_API_KEY itself.
const direct = new LlmAgent({
  name: 'claude_direct_agent',
  model: new AnthropicLlm({model: 'claude-sonnet-4-20250514'}),
});

// Claude on Vertex AI, with a smaller output budget.
const vertex = new LlmAgent({
  name: 'claude_vertex_agent',
  model: new Claude({model: 'claude-3-5-sonnet-v2@20241022', maxTokens: 4096}),
});
```

`model` defaults to `claude-sonnet-4-20250514` for `AnthropicLlm` and to
`claude-3-5-sonnet-v2@20241022` for `Claude`. `maxTokens` defaults to `8192`.

## Credentials

`AnthropicLlm` constructs the Anthropic client with no arguments, so the SDK
reads `ANTHROPIC_API_KEY` from the environment. ADK never reads that variable.

`Claude` reads `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`. A full model
resource name overrides both:

```ts
const llm = new Claude({
  model:
    'projects/my-project/locations/us-east5/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022',
});
```

Both values are read the first time you send a request, not in the constructor,
so `LLMRegistry.newLlm('claude-3-5-sonnet-v2@20241022')` succeeds in an
unconfigured environment. Generating content without either value throws.

ADK attaches its tracking headers (`x-goog-api-client` and `user-agent`) to the
Vertex AI client.

## Streaming

Pass `stream: true` to `generateContentAsync`. Claude emits one partial
response per text or thinking delta, then exactly one aggregated response with
`partial: false` and the token counts:

```ts
import {AnthropicLlm, LlmRequest} from '@google/adk';

const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
const request: LlmRequest = {
  model: 'claude-sonnet-4-20250514',
  contents: [{role: 'user', parts: [{text: 'What is 2 + 2?'}]}],
  config: {systemInstruction: 'Answer with the number only.'},
  liveConnectConfig: {},
  toolsDict: {},
};

let answer = '';
for await (const response of llm.generateContentAsync(request, true)) {
  if (response.partial) {
    answer += response.content?.parts?.[0].text ?? '';
  }
}
```

The final response holds the same parts, in the same order, that the
non-streaming call would return. Tool call arguments arrive as JSON fragments
and are parsed once the stream ends.

## Extended thinking

Set `config.thinkingConfig.thinkingBudget`. Anthropic requires an explicit
choice, so ADK throws when a thinking config states no budget.

| `thinkingBudget`                     | Anthropic thinking                  |
| ------------------------------------ | ----------------------------------- |
| `0`                                  | disabled                            |
| negative (genai `AUTOMATIC` is `-1`) | adaptive, the model picks the depth |
| positive                             | enabled, with that token budget     |

Anthropic owns the lower bound on a positive budget, so ADK does not check it.
Leaving `thinkingConfig` unset omits the parameter entirely.

## Limits

- **No live connections.** `connect()` throws. Anthropic has no bidirectional
  streaming API here, and adk-python does not support it either.
- **No media on an assistant turn.** Claude rejects image and PDF blocks on an
  assistant turn, so those parts are dropped with a warning rather than failing
  the request.
- **Image media types.** Claude accepts `image/jpeg`, `image/png`, `image/gif`
  and `image/webp`. Any other type throws, naming the type.
- **Tool call ids.** Anthropic rejects an id outside `[a-zA-Z0-9_-]+`. ADK maps
  each rejected id to a deterministic fallback for the whole request, so a
  `tool_use` block and the `tool_result` block answering it stay paired.
