# ToolboxToolset

Exposes the tools of an [MCP Toolbox for Databases](https://googleapis.github.io/genai-toolbox/)
server to an agent. Reach for it when a toolbox server already publishes the
database operations you want, so you do not hand-write a tool for each one.

## Introduction

A toolbox server sits in front of your database and publishes each operation as
a named tool with a parameter schema. `ToolboxToolset` connects to that server,
loads the tools you ask for, and wraps each one as an ADK `FunctionTool`. The
model sees the server's tool names, descriptions, and parameters; a call goes
back to the server, which runs the query.

Choose the tools by toolset name, by individual tool names, or by both. A
toolset is a group the server itself defines, so `toolsetName` is the usual
choice and `toolNames` picks extras. At least one of the two is required: a
toolset that loads nothing is a configuration mistake, not a valid default.

`ToolboxToolset` is a `BaseToolset`, so an agent takes it wherever it takes
tools, and it lists its tools on every turn. This is different from `MCPToolset`,
which speaks the Model Context Protocol over stdio or HTTP and manages a
session. A toolbox server speaks its own HTTP protocol, and each call is one
request.

## Get started

Install the optional peer dependency. ADK does not download it for you, because
applications that never use a toolbox server should not pay for it.

```bash
npm install @toolbox-sdk/core
```

Point the toolset at your server and give the agent the toolset:

```ts
import {LlmAgent, ToolboxToolset} from '@google/adk';

const toolbox = new ToolboxToolset('http://127.0.0.1:5000', {
  toolsetName: 'my-toolset',
});

const agent = new LlmAgent({
  name: 'hotel_agent',
  model: 'gemini-2.0-flash',
  tools: [toolbox],
});
```

To load named tools instead of, or in addition to, a toolset:

```ts
const toolbox = new ToolboxToolset('http://127.0.0.1:5000', {
  toolsetName: 'my-toolset',
  toolNames: ['search-hotels-by-name'],
});
```

`getTools()` returns the toolset's tools first, then the named tools in the
order you gave them.

## Renaming and narrowing the tools

A `prefix` renames every tool the server publishes, which keeps two toolbox
servers apart when both publish a `search`. A `toolFilter` then decides which of
those tools the agent sees. Give it the names to keep, or a predicate:

```ts
const toolbox = new ToolboxToolset('http://127.0.0.1:5000', {
  toolsetName: 'my-toolset',
  prefix: 'hotels',
  toolFilter: ['hotels_search-hotels-by-name'],
});
```

Both options behave as they do on `MCPToolset`. A name filter matches the
prefixed name, because that is the name the model calls. A predicate needs the
`ReadonlyContext` that an agent passes to `getTools()`; called without one, the
toolset keeps every tool and logs a warning rather than dropping the filter in
silence.

## What it guarantees

- **The constructor does no I/O.** The `@toolbox-sdk/core` package loads on the
  first `getTools()` call, because a dynamic `import()` cannot be awaited in a
  constructor. A missing package therefore surfaces on that first call, with an
  error naming the package and the `npm install` command.
- **One client per toolset.** The client is created once, even when two
  `getTools()` calls run concurrently.
- **No tool-list cache.** Every `getTools()` call asks the server again, so a
  tool added on the server appears on the next turn.
- **Errors reach you unchanged.** An unreachable server, an unknown toolset, or
  an unknown tool fails with the SDK's own error. ADK does not wrap it or retry.

One limit comes from `@toolbox-sdk/core` rather than from ADK: it builds its
parameter schema from the parameter types, so the description your server gives
a parameter does not reach the model. The tool's own description does.

## Closing

`close()` resolves immediately and leaves the toolset usable. The JavaScript
`ToolboxClient` makes one HTTP request per call and holds nothing that outlives
a request, so there is no resource to release.
