# AnthropicLlm and Claude

`AnthropicLlm` runs an ADK agent on a Claude model through the Anthropic API.
`Claude` runs the same models through Vertex AI. Reach for them when you want
Claude behind the same `LlmAgent` code that runs Gemini.

## Introduction

Both classes are `BaseLlm` implementations, so an agent uses them exactly as it
uses `Gemini`. They differ only in where the request goes and how it is
authenticated.

`Claude` is the class `LLMRegistry` resolves for a `claude-*` model name. A
bare model string therefore reaches Claude through your Google Cloud project,
which is the path most ADK users already have credentials for. To call the
Anthropic API directly, pass an `AnthropicLlm` instance instead of a string.

Both packages are optional peer dependencies. Installing `@google/adk` does not
download them, and ADK loads one only when you first use the matching class.
Install the one you need:

```
npm install @anthropic-ai/sdk        # AnthropicLlm
npm install @anthropic-ai/vertex-sdk # Claude
```

Neither class supports the live (bidirectional) API. `connect()` rejects.

## Get started

Set `ANTHROPIC_API_KEY` to a key from the Anthropic Console, then:

```ts
import {AnthropicLlm, InMemoryRunner, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'assistant',
  model: new AnthropicLlm({model: 'claude-sonnet-4-20250514'}),
  instruction: 'You are a concise assistant.',
});

const runner = new InMemoryRunner({agent, appName: 'claude_app'});
const session = await runner.sessionService.createSession({
  appName: 'claude_app',
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

For Vertex AI, set `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` to the
project and region serving the model, and name the model as a string:

```ts
const agent = new LlmAgent({
  name: 'assistant',
  model: 'claude-3-5-sonnet-v2@20241022',
});
```

A full Vertex AI resource name works too, and the project and region in it win
over the environment:

```ts
const agent = new LlmAgent({
  name: 'assistant',
  model:
    'projects/my-project/locations/us-east5/publishers/anthropic/models/claude-opus-4@20250514',
});
```

## Credentials

`AnthropicLlm` does not resolve a credential itself. It hands the job to
`@anthropic-ai/sdk`, which accepts `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
or a signed-in profile in the on-disk Anthropic configuration. If the SDK finds
none, the first request throws an `AnthropicCredentialError` naming
`ANTHROPIC_API_KEY`.

`Claude` reads `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, or the
project and region embedded in the model resource name. It throws when neither
supplies both, and the Google credential itself comes from Application Default
Credentials.

To bypass all of this — in a test, or to configure a proxy or a custom timeout
— pass a client you built yourself:

```ts
import Anthropic from '@anthropic-ai/sdk';
import {AnthropicLlm} from '@google/adk';

const llm = new AnthropicLlm({
  client: new Anthropic({
    apiKey: process.env['ANTHROPIC_API_KEY'],
    maxRetries: 5,
  }),
});
```

`Claude` accepts a client the same way, but rejects one that is not
Vertex-backed.

## Reasoning effort and extended thinking

Claude offers five reasoning effort levels while genai's `ThinkingLevel`
defines four, so the two do not map onto each other. Use
`AnthropicGenerateContentConfig` and set `effort`:

```ts
import {AnthropicGenerateContentConfig} from '@google/adk';

const config: AnthropicGenerateContentConfig = {effort: 'xhigh'};
```

A `thinkingConfig.thinkingLevel` set on its own is ignored with a warning.
Setting it together with `effort` throws.

`thinkingConfig.thinkingBudget` selects the thinking mode:

| `thinkingBudget`                 | Claude receives                                   |
| -------------------------------- | ------------------------------------------------- |
| unset (no `thinkingConfig`)      | no `thinking` parameter                           |
| `0`                              | `thinking.type: "disabled"`                       |
| negative, including genai's `-1` | `thinking.type: "adaptive"`                       |
| positive                         | `thinking.type: "enabled"` with that token budget |

Adaptive is required by Claude Opus 4.7, which rejects the manual mode.
Providing a `thinkingConfig` with no `thinkingBudget` throws, because Anthropic
requires an explicit choice.

Claude after Opus 4.6 refuses `temperature`, `topP` and `topK` when thinking or
an effort level is set. ADK drops them with one warning rather than letting the
request fail.

## Token counts

Anthropic reports cached and cache-write input tokens beside `input_tokens`,
while genai expects one prompt count. `promptTokenCount` is the sum of all
three, and `cachedContentTokenCount` is a breakdown of it rather than an
addition to it. Anthropic also counts extended-thinking tokens inside
`output_tokens`; ADK subtracts them, so `thoughtsTokenCount` and
`candidatesTokenCount` stay disjoint.

## Limits

Prompt caching is not implemented. ADK reports the cache token counts Claude
returns, but it never sets a cache breakpoint on a request.
