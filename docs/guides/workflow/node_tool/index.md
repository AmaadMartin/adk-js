# NodeTool

`NodeTool` exposes a workflow node to a model as a callable tool. Put a node or
a `Workflow` in an `LlmAgent`'s `tools` and the agent wraps it for you, so the
model can run a whole graph the same way it calls a function.

## Introduction

`ToolNode` puts a tool inside a workflow. `NodeTool` is the inverse: it puts a
workflow inside an agent. Reach for it when the model must decide _whether_ and
_with what_ to run a multi-step process — a lookup graph, an approval flow, a
node that pauses to ask the user a question.

The wrapped node runs under the calling agent's invocation and session, so it
shares state with the agent and its events stream into the same conversation.
The node's structured output becomes the tool result the model reads. A node
that pauses for input leaves the tool call open, and the next turn resumes it.

A node must declare an `inputSchema`, because the tool's parameter schema comes
from it. The one exception is a `FunctionNode` that takes no input: it is
declared with no parameters. An agent cannot be wrapped — put it in `subAgents`
instead.

## Get started

The smallest useful case is a `Workflow` in `tools`, which the agent wraps
automatically:

```ts
import {LlmAgent, NodeContext, START, Workflow, node} from '@google/adk';
import {z} from 'zod';

const lookupCustomer = node(
  (_ctx: NodeContext, input: {userId: string}) => ({
    userId: input.userId,
    tier: 'Verified VIP Member',
  }),
  {name: 'lookup_customer'},
);

const customerLookup = new Workflow({
  name: 'customer_lookup_workflow',
  description: 'Looks up customer status and tier by user id.',
  inputSchema: z.object({userId: z.string()}),
  edges: [[START, lookupCustomer]],
});

const agent = new LlmAgent({
  name: 'customer_service_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Look the customer up before you answer.',
  tools: [customerLookup],
});
```

Construct the tool yourself when you want a different name or description:

```ts
import {NodeTool} from '@google/adk';

const tool = new NodeTool(customerLookup, 'lookup', 'Look a customer up.');
```

## What the model is told

The declaration is derived from the node's schemas:

| Node                                              | Declaration                                              |
| ------------------------------------------------- | -------------------------------------------------------- |
| Zod object `inputSchema`                          | `parameters`, a genai `Schema`                           |
| Any other `inputSchema` of object type            | `parametersJsonSchema`, the schema as JSON Schema        |
| Scalar `inputSchema` (`z.number()`, `z.string()`) | `parametersJsonSchema`, wrapped as `{request: <schema>}` |
| `FunctionNode` with no `inputSchema`              | no parameters                                            |
| `outputSchema` set                                | `responseJsonSchema`                                     |

The wrapping of a scalar exists because the API accepts an object-typed
parameter schema only. It is unwrapped again on the way in, so the node still
receives the bare value.

## Failures the model sees

A failure inside the node is a tool result, not an exception. The model reads
it and can retry or explain:

- Arguments that fail a Zod `inputSchema`:
  `Error validating input for node: <message>`.
- Any other failure of the node: `Error running node <name>: <message>`.

Two errors keep propagating instead, because the invocation cannot continue past
them: a cancelled invocation, and a dynamic child node's own failure.

Three conditions still throw out of the tool, because they report a
misconfigured host rather than a failing node: no invocation event queue, no
function-call id, and node-tool nesting deeper than eight levels. The nesting
limit guards against a node that is exposed as a tool to an agent the node
itself runs.

## Human-in-the-loop

A node that yields a `RequestInput` pauses. `NodeTool` is long-running, so the
tool call stays open, the interrupt reaches the session, and the answer resumes
the node on the next turn. The runnable example is
`tests/integration/workflows/node_as_tool/agent.ts`.

## Differences from adk-python

- adk-python rebuilds a `FunctionNode` with `parameter_binding='node_input'`
  before wrapping it. adk-js has no `parameterBinding`: a handler takes
  `(ctx, input)` explicitly, so there is nothing to realign.
- `MAX_NODE_TOOL_DEPTH` has no adk-python counterpart.
- adk-python emits `parameters_json_schema` for every input schema. adk-js
  keeps emitting genai `parameters` for a Zod object schema.
