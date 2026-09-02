# LangchainTool

Wraps a [LangChain JS](https://js.langchain.com/) tool so an ADK agent can call
it. Reach for it when you already hold a LangChain tool and you want an ADK
agent to use it without rewriting it.

## Introduction

ADK and LangChain both describe a tool as a name, a description and an argument
schema, but they expose it differently. An ADK agent needs a
`FunctionDeclaration` it can send to the model, plus something to run when the
model calls it. A LangChain tool holds the same information under different
names, and adds `returnDirect`, which asks the framework to hand the tool's
output to the user unchanged.

`LangchainTool` maps one onto the other. It runs the tool through LangChain's
own `invoke`, so the LangChain tool keeps ownership of argument validation and
of its callback plumbing, and neither leaks into the schema the model sees.

`LangchainTool` extends `FunctionTool`, so an agent treats it as an ordinary
function tool. Write a plain `FunctionTool` for new code; use `LangchainTool`
only to adopt a tool that already exists in LangChain form.

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

The model sees a function called `add` that takes two numbers. Pass `name` or
`description` to replace strings a third-party tool wrote for a different
audience; an override always wins. The tool must end up with a name, so the
constructor throws when it has neither its own `name` nor an override.

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
the user as it is. `LangchainTool` honours that by setting `skipSummarization`
on the tool context after a run that returns.

```ts
const lookup = tool(({id}: {id: string}) => `record ${id}`, {
  name: 'lookup',
  description: 'Fetches a record verbatim',
  schema: z.object({id: z.string()}),
  returnDirect: true,
});
```

One result is exempt. A tool that returns an object with a truthy `error`
property keeps its result summarizable, so the model reads the error and can
retry. An `error` property that is falsy, such as `{error: null, value: 1}`, is
a real result and still skips summarization. This matches adk-python.

## Failure modes

- The wrapped tool throws. `FunctionTool` wraps it as
  `Error in tool '<name>': <message>` and the error propagates.
  `skipSummarization` is not set, so the model sees the failure and can retry.
- The model sends arguments the tool's schema rejects. LangChain's own
  validation throws, and the same wrapping applies. ADK does not validate the
  arguments itself, so the error text comes from LangChain.
- The object you pass has no `invoke` method, or ends up with no name. The
  constructor throws.
