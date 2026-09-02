# Model capabilities

`BaseLlm.capabilities` is how a model tells ADK what it supports. Reach for it
when your code needs to branch on a model's abilities, and override it when you
write a model whose abilities ADK cannot guess.

## Introduction

Some features work on one model and not on another. Pairing an output schema
with tools is the current example: Gemini accepts both at once on Vertex AI,
and elsewhere ADK falls back to a prompt-based `set_model_response` tool.

Before this property existed, each caller decided that for itself by inspecting
the model name. That works only for the models ADK ships. A model you wrote has
a name ADK has never seen, so name inspection always denies it, and you have no
way to say otherwise.

`capabilities` moves the decision to the model. The model answers the question
once, callers read the answer, and a model outside ADK gets the same say as one
inside it.

Each field is the resolved result for one capability, not a request or an
override. `LlmCapabilities` declares one field today:

- `outputSchemaAndTools` — the model can use an output schema together with
  tools.

The getter recomputes on every access, so a capability that depends on the
environment stays correct after the environment changes. Never cache the
snapshot, in your override or at the call site.

## Get started

Read a capability from any model instance:

```ts
if (model.capabilities.outputSchemaAndTools) {
  // Send the output schema and the tools in one request.
}
```

Declare capabilities outright when you subclass `BaseLlm` directly:

```ts
import {BaseLlm, LlmCapabilities, LlmRequest, LlmResponse} from '@google/adk';

class EchoLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    /echo-.*/,
  ];

  override get capabilities(): LlmCapabilities {
    return {outputSchemaAndTools: true};
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const prompt = llmRequest.contents.at(-1)?.parts?.[0]?.text ?? '';
    yield {
      content: {
        role: 'model',
        parts: [{text: `${this.model} heard: ${prompt}`}],
      },
    };
  }
}

new EchoLlm({model: 'echo-v1'}).capabilities.outputSchemaAndTools; // true
```

## Extending a model ADK ships

Spread `super.capabilities` instead of listing every field. Capabilities your
override does not name then keep the parent's value, including capabilities
added to `LlmCapabilities` after you wrote the subclass.

```ts
import {Gemini, LlmCapabilities} from '@google/adk';

class SchemaAwareGemini extends Gemini {
  override get capabilities(): LlmCapabilities {
    return {...super.capabilities, outputSchemaAndTools: true};
  }
}
```

Do the opposite in a direct `BaseLlm` subclass, and declare every field: on
`BaseLlm`, `super.capabilities` is the deprecated fallback described below.

## The deprecated name-based fallback

A model that does not override `capabilities` still resolves the way it did
before the property existed: `BaseLlm` reads the model name. A subclass with a
Gemini 2.0-or-later name, running on Vertex AI, therefore gets
`outputSchemaAndTools: true` and one log warning:

```
MyModel relies on name-based detection of outputSchemaAndTools. Override
BaseLlm.capabilities to declare it explicitly; this fallback will be removed
in a future release.
```

The warning is logged once per class, and only when the fallback grants the
capability. Those are the models whose behaviour changes once the fallback
goes. Declaring `capabilities` silences it. `Gemini` declares its own, so
neither `Gemini` nor its subclasses reach the fallback.

## Models that do not implement a transport

`BaseLlm` supplies both transports so that a subclass implements only the one
it needs. The default `generateContentAsync` throws on first iteration, and the
default `connect` returns a rejected promise:

```
Async generation is not supported for <model>.
Live connection is not supported for <model>.
```

A model that only answers turn by turn overrides `generateContentAsync` alone.
A caller that asks it for a live connection gets the message above rather than
a missing-method error.
