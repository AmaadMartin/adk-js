# MCP resources and declarative MCP servers

An MCP server can publish two kinds of thing: tools the model calls, and
resources the model reads. `MCPToolset` discovers the tools on its own. Set
`useMcpResources: true` to also give the model `load_mcp_resource`, the tool
that reads the server's resources into the conversation. Use
`MCPToolset.fromConfig` when the server is described by data rather than by
code.

## Introduction

A resource is a document the server owns: a README, a schema, a log file, an
image. It is not a tool, so the model cannot call it, and `getTools()` never
returns it. Without a way to reach resources, an agent connected to a
documentation server can list its tools but cannot read a single page.

`LoadMcpResourceTool` closes that gap. It is a normal ADK tool named
`load_mcp_resource`. The model calls it with the resource names it wants. On
the next turn the tool reads those resources over the MCP session and appends
their contents to the request, as text or as base64 inline data. It also tells
the model which resources exist, so the model knows what it may ask for.

`useMcpResources` is the switch that puts that tool in the list. It defaults to
false, because most MCP servers publish no resources and an extra tool costs
prompt space. `MCPToolset` appends the tool after the server's own tools and
after the `toolFilter` runs, so a filter that names only server tools cannot
drop it.

`fromConfig` is the other half. It builds a toolset from a plain object, which
is what you have when the server is declared in a configuration file rather
than in code. That object is often less trusted than code, so `fromConfig`
refuses a stdio server unless the application opts in. A stdio server is a
`command` that ADK launches as a local child process. A configuration that can
name any command can run any code.

## Get started

Give the model the server's resources:

```ts
import {MCPToolset} from '@google/adk';

const toolset = new MCPToolset({
  connectionParams: {
    type: 'StreamableHTTPConnectionParams',
    url: 'https://example.com/mcp',
  },
  useMcpResources: true,
});

const tools = await toolset.getTools();
// The server's own tools, then 'load_mcp_resource'.
```

Pass the toolset to an agent and the model can read the resources:

```ts
import {LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'docs_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer questions about the documents on the MCP server.',
  tools: [toolset],
});
```

## Build a toolset from configuration

`MCPToolset.fromConfig` takes an `McpToolsetConfig`. Exactly one connection
field must be set:

```ts
import {MCPToolset} from '@google/adk';

const toolset = MCPToolset.fromConfig({
  streamableHttpConnectionParams: {
    type: 'StreamableHTTPConnectionParams',
    url: 'https://example.com/mcp',
  },
  toolFilter: ['search'],
  prefix: 'docs',
  useMcpResources: true,
});
```

Setting none of them, or both, throws. The message names both fields.

## Allow a stdio server in configuration

A remote transport is never gated. A stdio server is, and `fromConfig` throws
until the application allows it. Two ways to allow it:

```bash
export ADK_ALLOW_CONFIG_STDIO_MCP_SERVERS=1
```

```ts
import {setAllowConfigStdioMcpServers} from '@google/adk';

// Call this at startup, before any config is loaded.
setAllowConfigStdioMcpServers(true);
```

The in-process setting wins over the environment variable. Pass `false` to deny
a stdio server even where the variable says yes, and `undefined` to go back to
reading the variable. Constructing an `MCPToolset` directly is never gated: your
own code already decides what runs.

## What the resource tool does not do

The contents `load_mcp_resource` appends live in one request. They are not
stored in the session and they are not cached, so the model must call the tool
again in a later turn to see them again. The tool says so in its own response.

If listing or reading a resource fails, the tool logs a warning and continues
with the resources it could read. A broken resource does not fail the turn.
