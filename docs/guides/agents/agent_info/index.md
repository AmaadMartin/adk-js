# Agent info

`getAgentsInfo` flattens an agent tree into a map of per-agent metadata: name,
description, instruction, resolved tool declarations, and direct sub-agent
names. Reach for it when a host must describe a loaded app without running it.

## Introduction

An assembled `LlmAgent` tree holds the answer to "what can this app do", but the
answer is spread across the tree. Tools arrive as a `ToolUnion`, so a `tools`
array may hold a `BaseTool`, a `BaseToolset` that resolves to many tools, or a
`BaseNode` that becomes a tool. Reading `agent.tools` therefore tells you what
was configured, not what the model sees.

`getAgentsInfo` resolves that union and returns the declarations the model would
receive. It solves the problem for a describe endpoint, a CLI command that
prints an app's shape, and a test that asserts an assembled tree exposes the
tools it should.

Two neighbouring pieces do related work:

- `LlmAgent.canonicalTools()` resolves one agent's tools to `BaseTool`
  instances. `getToolsInfo` resolves the same union to `Tool` declarations, and
  walks no tree.
- The dev server's `serializeAppInfo` builds the nested graph payload for the
  dev UI. It reports tool _names_ only and never resolves a toolset, so it stays
  cheap. `getAgentsInfo` resolves them, and returns a flat map instead of a
  tree.

This is a port of `google/adk-python`
`src/google/adk/utils/agent_info.py`. The type is named `LlmAgentInfo` because
`@google/adk` already exports an unrelated `AgentInfo` for the remote agent
registry.

## Get started

```ts
import {FunctionTool, getAgentsInfo, LlmAgent} from '@google/adk';
import {z} from 'zod';

const lookupOrder = new FunctionTool({
  name: 'lookup_order',
  description: 'Looks up an order by id.',
  parameters: z.object({orderId: z.string()}),
  execute: ({orderId}) => ({orderId, status: 'shipped'}),
});

const orders = new LlmAgent({
  name: 'orders',
  description: 'Answers order questions.',
  instruction: 'Call lookup_order before you answer.',
  tools: [lookupOrder],
});

const support = new LlmAgent({
  name: 'support',
  description: 'Front desk.',
  instruction: 'Route the user to a specialist.',
  subAgents: [orders],
});

const agents = await getAgentsInfo(support);
```

`agents` is a plain object, so `JSON.stringify` works on it directly:

```json
{
  "orders": {
    "name": "orders",
    "description": "Answers order questions.",
    "instruction": "Call lookup_order before you answer.",
    "tools": [
      {
        "functionDeclarations": [
          {
            "name": "lookup_order",
            "description": "Looks up an order by id.",
            "parameters": {
              "type": "OBJECT",
              "properties": {"orderId": {"type": "STRING"}},
              "required": ["orderId"]
            }
          }
        ]
      }
    ],
    "subAgents": []
  },
  "support": {
    "name": "support",
    "description": "Front desk.",
    "instruction": "Route the user to a specialist.",
    "tools": [],
    "subAgents": ["orders"]
  }
}
```

## Which agents you get back

Only `LlmAgent` edges are followed. A sub-agent of any other type is skipped: it
gets no key, it is not named in its parent's `subAgents`, and its own
descendants stay invisible. This surprises people who nest an `LlmAgent` under a
`RoutedAgent` and expect to find it. The Python reference behaves the same way,
and matching it is deliberate.

The per-call contract — post-order keys, one key per agent, declaration order in
`subAgents` — is on the TSDoc for `getAgentsInfo`.

## Resolving tools on their own

`getToolsInfo` takes the raw `tools` array and returns what the model would be
given:

```ts
import {getToolsInfo} from '@google/adk';

const tools = await getToolsInfo(orders.tools);
```

A tool that declares nothing is omitted, which is how a built-in such as Google
Search stays out of the list.

## Cost

Resolving a `BaseToolset` calls its `getTools()`. For a remote toolset (MCP,
OpenAPI) that performs I/O, so `getAgentsInfo` is not a free structure read.
Call it once and cache the result if a host serves it per request.
