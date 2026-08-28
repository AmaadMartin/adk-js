# LangchainTool

Wraps a [LangChain JS](https://js.langchain.com/) tool so an ADK agent can call
it. Reach for it when you already hold a LangChain tool — one you wrote, or one
from a LangChain integration package — and you want an ADK agent to use it
without rewriting it.

## Introduction

ADK and LangChain both describe a tool as a name, a description and an argument
schema, but they expose it differently. An ADK agent needs a
`FunctionDeclaration` it can send to the model, plus something to run when the
model calls it. A LangChain tool holds the same information under different
names, and adds `returnDirect`, which asks the framework to hand the tool's
output to the user unchanged.

`LangchainTool` maps one onto the other. It derives the declaration from the
wrapped tool's `name`, `description` and `schema`, and it runs the tool through
the tool's own entry point. That last part matters: the LangChain tool keeps
ownership of argument validation and of its callback plumbing, so neither leaks
into the schema the model sees.

`LangchainTool` extends `FunctionTool`, so an agent treats it as an ordinary
function tool. Use a plain `FunctionTool` when you are writing new code; use
`LangchainTool` only to adopt a tool that already exists in LangChain form.

`@langchain/core` is an optional peer dependency. The adapter never imports it,
so an install that does not use LangChain pays nothing for this class.

## Get started

Install `@langchain/core` alongside `@google/adk`, then wrap the tool and put it
in the agent's `tools` list.

```ts
import {LangchainTool, LlmAgent} from '@google/adk';
import {tool} from '@langchain/core/tools';
import {z} from 'zod';

const add = tool(({x, y}: {x: number; y: number}) => x + y, {
  name: 'add',
  description: 'Adds two numbers',
  schema: z.object({x: z.number(), y: z.number()}),
});

const agent = new LlmAgent({
  name: 'calculator',
  model: 'gemini-2.5-flash',
  tools: [new LangchainTool({tool: add})],
});
```

The model sees a function called `add` that takes two numbers.

## Overriding the name and description

A third-party tool often carries strings written for a different audience. Pass
`name` or `description` to replace them. An override always wins over the
wrapped tool's own value.

```ts
new LangchainTool({
  tool: someVendorSearchTool,
  name: 'web_search',
  description: 'Searches the public web and returns the top results.',
});
```

The wrapped tool must end up with a name. `LangchainTool` throws when the tool
has no `name` and you pass no override, because a declaration without a name is
not callable.

## Supported schemas

`schema` is read from the wrapped tool and converted to the declaration's
parameters:

| The tool's `schema`                                                                | The declared parameters                       |
| ---------------------------------------------------------------------------------- | --------------------------------------------- |
| A Zod object, such as `z.object({x: z.number()})`                                  | The equivalent object schema                  |
| LangChain's string-input `Tool`, whose schema is a transformed `z.object({input})` | `{input: string}`, the transform's input side |
| A plain JSON Schema object                                                         | The equivalent schema                         |
| Absent                                                                             | An empty object schema                        |

Anything else — a number, a string, an array — throws
`Failed to build function declaration for Langchain tool: ...` at construction
time, so a broken tool fails when you build the agent rather than mid-turn.

## returnDirect

A LangChain tool built with `returnDirect: true` asks for its output to reach
the user as it is. `LangchainTool` honours that by setting
`skipSummarization` on the tool context after the run.

```ts
const lookup = tool(({id}: {id: string}) => `record ${id}`, {
  name: 'lookup',
  description: 'Fetches a record verbatim',
  schema: z.object({id: z.string()}),
  returnDirect: true,
});

const agent = new LlmAgent({
  name: 'records',
  model: 'gemini-2.5-flash',
  tools: [new LangchainTool({tool: lookup})],
});
```

One exception: a result that is an object with a truthy `error` property stays
summarizable, so the model sees the failure and can retry. A falsy `error` —
`{error: null, value: 1}` — is a real result and does skip summarization.

## Failure modes

- The wrapped tool throws. `FunctionTool` wraps it as
  `Error in tool '<name>': <message>` and the error propagates.
  `skipSummarization` is not set.
- The model sends arguments the tool's schema rejects. The wrapped tool's own
  validation throws, and the same wrapping applies. ADK does not validate the
  arguments itself, so the error text comes from LangChain.
- The object you pass exposes none of `invoke`, `call` or `func`. The
  constructor throws.
