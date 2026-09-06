# LlmRequest

`LlmRequest` is the object ADK builds for one model call. A request processor
or a tool receives it, adds an instruction or a tool declaration to it, and the
model implementation turns it into the provider call.

## Introduction

Several contributors write into the same request. Agent processors add the
agent instruction, each tool adds its function declaration, and a retrieval
tool adds recalled content. Each contributor sees only its own piece, so the
request object owns the rules that keep the result valid for the provider.

Three of those rules matter to anyone writing a tool or a processor.

The Gemini API accepts one system instruction, and it must be a string. Text
instructions are joined with a blank line between them. An instruction that
carries binary content cannot go there at all, so ADK writes a readable
reference into the system instruction and moves the binary part into the
contents as a user message.

The Gemini API also accepts at most one tool that carries function
declarations. A contributor that adds a declaration merges it into the existing
tool rather than adding a second one.

Ordinary conversation history should stay stable across turns, because a
provider can cache a stable prefix. Request-scoped content, such as recalled
memory, is therefore inserted at the current-turn boundary rather than appended
to the end.

## Get started

A tool declares itself to the model by returning a `FunctionDeclaration`. The
base class writes it into the request for you.

```ts
import {BaseTool, RunAsyncToolRequest} from '@google/adk';
import {FunctionDeclaration, Type} from '@google/genai';

class WeatherTool extends BaseTool {
  constructor() {
    super({name: 'get_weather', description: 'Reads the local forecast.'});
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {city: {type: Type.STRING}},
        required: ['city'],
      },
    };
  }

  async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    return {forecast: `Sunny in ${String(args['city'])}.`};
  }
}
```

Give the tool to an `LlmAgent`. On every turn ADK builds one `LlmRequest` and
calls each tool's `processLlmRequest`. That merges the declaration into the
single `Tool` in `request.config.tools`, and registers the instance in
`request.toolsDict` under its name. Add a second tool and its declaration joins
the same `Tool`, because the Gemini API rejects a request carrying two of them.

Register two tools under one name and the second one wins. ADK logs a warning
naming the tool, because the first tool's declaration is still advertised to
the model while calls reach only the survivor.

## Instructions that carry binary content

When an instruction arrives as a `Content` rather than a string, ADK splits it.
Every text part goes into the system instruction. Every `inlineData` or
`fileData` part becomes two things: a reference line in the system instruction,
and a user content holding the data.

An instruction with the text `Analyze this:` followed by a PNG named
`test.png` produces this system instruction:

```
Analyze this:

[Reference to inline binary data: inline_data_0 ('test.png', type: image/png)]
```

and one user content whose parts are the text
`Referenced inline data: inline_data_0` and the original blob. Reference ids
number the non-text parts in the order they appear, across both kinds, so an
inline part followed by a file part yields `inline_data_0` then `file_data_1`.

## Context caching fields

`LlmRequest` carries three fields a caching layer reads: `cacheConfig`,
`cacheMetadata` and `cacheableContentsTokenCount`. They are plain data on the
request. adk-js has no caching layer yet, so nothing in this package writes or
reads them today.

`CacheMetadata` is valid in one of two states. An active cache sets
`cacheName`, `expireTime` and `invocationsUsed` together. A fingerprint-only
record leaves all three absent and describes the cacheable prefix with
`fingerprint` and `contentsCount` alone.

## Failure modes

`appendInstructions` throws a `TypeError` when the instructions are neither a
string array nor a `Content`.

`config.systemInstruction` is typed `ContentUnion`, so it can already hold a
`Content` or a `Part[]`. ADK cannot append text to those, so it leaves the
value alone and logs a warning instead of stringifying it.
