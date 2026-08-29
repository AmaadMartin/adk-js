# CrewaiTool

`CrewaiTool` wraps a CrewAI tool so an ADK agent can call it. Reach for it when
you already have a CrewAI-shaped tool object and you do not want to rewrite it
as a `FunctionTool`.

## Introduction

An ADK agent needs two things from a tool: a function declaration to show the
model, and something to call when the model picks it. A CrewAI tool already
carries both. It has a display name, a description, a JSON Schema for its
arguments, and a `run` method.

Without an adapter you write that mapping by hand for every tool. You copy the
description, convert the schema to a Gemini `Schema`, and normalise the name,
because CrewAI names contain spaces and a function declaration name cannot.
`CrewaiTool` does that mapping once.

The adapter takes no dependency on a CrewAI package. CrewAI publishes a Python
SDK, so there is no first-party npm package to import. `CrewaiBaseTool` is a
structural interface instead: any object with the right members can be wrapped,
whether it comes from a community port or you wrote it yourself. Importing
`@google/adk` never requires CrewAI to be installed.

Use `MCPToolset` instead when the tool lives behind an MCP server, and
`FunctionTool` when you are writing the tool yourself.

## Get started

```ts
import {CrewaiBaseTool, CrewaiTool, LlmAgent} from '@google/adk';

const serperDevTool: CrewaiBaseTool = {
  name: 'Serper Dev Tool',
  description: 'Search the internet with Serper.',
  argsSchema: {
    type: 'object',
    properties: {
      search_query: {type: 'string', description: 'The query to search for.'},
    },
    required: ['search_query'],
  },
  run: async (args: Record<string, unknown>) => {
    return {results: [`a result for ${args['search_query']}`]};
  },
};

const agent = new LlmAgent({
  name: 'researcher',
  model: 'gemini-2.5-flash',
  tools: [new CrewaiTool(serperDevTool)],
});
```

The model sees the tool as `serper_dev_tool`.

The `CrewaiBaseTool` annotation is optional. A plain object literal matches the
interface too, and so does a tool object from a CrewAI port that carries the
library's own typing.

## The tool interface

`CrewaiBaseTool` has four members.

| Member                   | Purpose                                            |
| ------------------------ | -------------------------------------------------- |
| `name`                   | The display name. May contain spaces.              |
| `description`            | Shown to the model.                                |
| `argsSchema`             | Optional JSON Schema for the arguments.            |
| `run(args, toolContext)` | Runs the tool. May be synchronous or asynchronous. |

`run` receives the model's arguments as its first parameter and the ADK
`Context` as its second. The adapter awaits the result, so a `run` that returns
a promise and a `run` that returns a value both work.

## Name and description

The constructor derives both, and an explicit option wins.

```ts
// Derived: name becomes 'serper_dev_tool'.
new CrewaiTool(serperDevTool);

// Explicit: name stays 'web_search' exactly as written.
new CrewaiTool(serperDevTool, {
  name: 'web_search',
  description: 'Search the public web.',
});
```

A derived name replaces every space with `_` and lowercases the result. An
explicit name is used verbatim, so it is yours to keep valid. The constructor
throws when neither the option nor the tool supplies a name.

## Required arguments

The adapter checks `argsSchema.required` before it calls `run`. When an
argument is missing it returns an `{error}` payload instead of running the
tool:

```
Invoking `serper_dev_tool()` failed as the following mandatory input parameters are not present:
search_query
You could retry calling this tool, but it is IMPORTANT for you to provide all the mandatory parameters.
```

This is a returned value, not a thrown error. The model reads it as the tool's
response and can retry with the missing argument. The wording matches
adk-python, so a model behaves the same against either SDK.

An argument counts as present when the key is present, even when its value is
`undefined`. A tool that declares no `required` list never fails this check.

## The reserved context argument

A model can put a `tool_context` or `toolContext` key in the arguments. The
adapter strips both before calling `run`, because the real context arrives as
`run`'s second parameter. Your `run` never sees either key.

## What the model sees

`_getDeclaration()` builds the declaration from the wrapped tool.
`toGeminiSchema` converts `argsSchema` into the `parameters`. When the schema
declares no properties, or the tool declares no schema at all, `parameters` is
`undefined` — the model is told the tool takes no arguments rather than being
shown an empty object.

## Errors from the tool

`CrewaiTool` is a `FunctionTool`, so an error thrown or rejected by `run`
surfaces the way every other function-shaped tool in ADK reports one:

```
Error in tool 'serper_dev_tool': the underlying message
```

A missing required argument is not an error. It is a returned value, so that
the model can read it and retry.
