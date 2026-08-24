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

## What the map guarantees

- **Children come first.** An agent's key is written after every one of its
  `LlmAgent` children, so `Object.keys` is a post-order listing.
- **One key per agent.** An agent reachable by two paths is recorded once, and
  is still named in both parents' `subAgents`.
- **`LlmAgent` edges only.** A sub-agent of any other type is skipped: it gets
  no key, it is not named in its parent's `subAgents`, and its own descendants
  stay invisible. This matches the Python reference.
- **`subAgents` names direct children only**, in declaration order. Every name
  in it is also a key of the map.

## Resolving tools on their own

`getToolsInfo` takes the raw `tools` array and returns what the model would be
given:

```ts
import {getToolsInfo} from '@google/adk';

const tools = await getToolsInfo(orders.tools);
```

Each returned `Tool` carries exactly one `FunctionDeclaration`. The declarations
keep the input order, with a toolset expanded in the position it occupied. A
tool that declares nothing is omitted, which is how a built-in such as Google
Search stays out of the list.

## Cost and failure modes

Resolving a `BaseToolset` calls its `getTools()`. For a remote toolset (MCP,
OpenAPI) that performs I/O, so `getAgentsInfo` is not a free structure read.
Call it once and cache the result if a host serves it per request.

Nothing is caught. An error from `getTools()` or from a tool's declaration
propagates to your caller, and you get no partial map.

An agent whose `instruction` is an `InstructionProvider` reports `instruction:
''`. Resolving a provider needs a live `ReadonlyContext`, which a structure
query does not have.
