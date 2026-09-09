# CrewaiTool

Wraps a [CrewAI](https://docs.crewai.com/) tool so an ADK agent can call it.
Reach for it when you already hold a CrewAI tool and you want an ADK agent to
use it without rewriting it.

## Introduction

A CrewAI tool holds a name, a description, an argument schema and a `run`
method. An ADK agent needs a `FunctionDeclaration` it can send to the model,
plus something to run when the model calls it. `CrewaiTool` maps one onto the
other.

Two details are specific to CrewAI. A CrewAI tool name may contain spaces, which
a function declaration cannot carry, so the adapter lowercases the name and
replaces each space with an underscore. A CrewAI tool also takes arbitrary
keyword arguments, so every argument the model sends reaches `run`, except the
framework-reserved names `self`, `tool_context` and `toolContext`.

`CrewaiTool` extends `FunctionTool`, so an agent treats it as an ordinary
function tool. Write a plain `FunctionTool` for new code. Use `CrewaiTool` only
to adopt a tool that already exists in CrewAI form.

`@google/adk` takes no dependency on CrewAI. The adapter describes the wrapped
tool structurally, so any object with a `run` method works.

## Get started

Wrap the tool and put it in the agent's `tools` list.

```ts
import {CrewaiTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

const searchTool = {
  name: 'Serper Dev Tool',
  description: 'Searches the web',
  argsSchema: z.object({query: z.string()}),
  run: ({query}: {query: string}) => `hit: ${query}`,
};

const agent = new LlmAgent({
  name: 'researcher',
  model: 'gemini-2.5-flash',
  tools: [new CrewaiTool({tool: searchTool})],
});
```

The model sees a function called `serper_dev_tool` that takes a `query` string.
Pass `name` or `description` to replace strings a third-party tool wrote for a
different audience. An override always wins, and it is used as you write it: the
space-to-underscore rule applies only to the wrapped tool's own name. The tool
must end up with a name, so the constructor throws when it has neither its own
`name` nor an override.

## Building from a config file

An agent config file cannot hold a tool object, so `CrewaiToolConfig` names one
instead. `CrewaiTool.fromConfig` resolves that name and builds the wrapper.

```ts
import {CrewaiTool} from '@google/adk';

const tool = await CrewaiTool.fromConfig(
  {tool: './my_tools.js#searchTool', name: 'web_search'},
  '/path/to/root_agent.yaml',
);
```

`tool` is a fully-qualified name of the form `<module specifier>#<export>`. The
export name is optional and defaults to `default`. A relative specifier resolves
against the directory of the config file you pass as the second argument. A bare
specifier resolves the way Node resolves an installed package.

An empty `name` or `description` counts as absent, so the wrapped tool keeps its
own. This matches adk-python, which defaults both to `''` and reads them
truthily.

The import runs the named module's top-level code, so trust the name as far as
you trust the config file it came from. A Node built-in is refused, so a config
file cannot reach `node:child_process`.

## Failure modes

- `tool` is missing, empty, or not a string. `fromConfig` throws
  `ToolExecutionError` with `errorType` `BAD_REQUEST`.
- `tool` names a module or an export that does not resolve. `fromConfig` throws
  `InputValidationError` with the underlying failure as its `cause`.
- `tool` resolves to a value with no callable `run`. `fromConfig` throws
  `ToolExecutionError` with `errorType` `BAD_REQUEST`. Use `isCrewaiToolLike` to
  test a value yourself.
- The model omits a mandatory argument. The tool returns a retry hint that lists
  the missing names, rather than throwing, so the model can correct itself.
- The wrapped tool throws. `FunctionTool` wraps it as
  `Error in tool '<name>': <message>` and the error propagates.

## The deprecated import path

`@google/adk/tools/crewai_tool` re-exports the adapter and warns once when it is
evaluated. It exists so an import written against the old path keeps working.
Import from `@google/adk` instead.

```ts
// Deprecated, still resolves.
import {CrewaiTool} from '@google/adk/tools/crewai_tool';
// Preferred.
import {CrewaiTool} from '@google/adk';
```
