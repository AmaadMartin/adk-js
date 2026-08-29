# TransferToAgentTool

Hands off control from one agent to another. Its declaration lists the
reachable agent names as a JSON-Schema `enum`, so a model that follows the
schema cannot name an agent that does not exist.

## Introduction

An `LlmAgent` with sub-agents, a parent, or peers can transfer a question to
one of them. The model asks for the hand-off by calling the
`transfer_to_agent` tool with an `agentName`. If the parameter is a free-form
string, the model can invent a name — `billing-agent` for an agent called
`billing_agent` — and the hand-off fails after the call.

`TransferToAgentTool` closes that gap. It is a `FunctionTool` whose
declaration constrains `agentName` to the names it was constructed with.
`AgentTransferLlmRequestProcessor` builds one for every request, from the
targets it already computes, so an agent tree gets the constraint without any
configuration. Construct the tool yourself only when you build a request or
inspect a declaration by hand.

The constraint is a hint to the model, not a run-time check. An unknown name
still reaches the tool and sets the hand-off; the transfer then fails when
`LlmAgent` looks the agent up.

## Get started

Nothing to configure: give an agent sub-agents and the constraint is in the
request the framework sends.

```ts
import {LlmAgent} from '@google/adk';

const rootAgent = new LlmAgent({
  name: 'root_agent',
  model: 'gemini-2.5-flash',
  subAgents: [
    new LlmAgent({
      name: 'billing_agent',
      model: 'gemini-2.5-flash',
      description: 'Answers billing questions.',
    }),
    new LlmAgent({
      name: 'support_agent',
      model: 'gemini-2.5-flash',
      description: 'Answers support questions.',
    }),
  ],
});
```

The model receives one `transfer_to_agent` declaration whose `agentName` is
restricted to `billing_agent` and `support_agent`.

## Build the tool directly

Pass the valid names to the constructor.

```ts
import {TransferToAgentTool} from '@google/adk';

const tool = new TransferToAgentTool({agentNames: ['triage', 'refunds']});
const declaration = tool._getDeclaration();
```

`declaration` is:

```json
{
  "name": "transfer_to_agent",
  "description": "Transfer the question to another agent. ...",
  "parameters": {
    "type": "OBJECT",
    "properties": {
      "agentName": {
        "type": "STRING",
        "description": "the agent name to transfer to.",
        "enum": ["triage", "refunds"]
      }
    },
    "required": ["agentName"]
  }
}
```

The tool copies the names it is given, so a later change to your array does
not change the declaration. Calling `_getDeclaration()` twice returns the same
result.

Do not add this tool to an agent that already has transfer targets. The
processor registers its own, and a second registration under the same name
throws `Duplicate tool name: transfer_to_agent`.

## Transfer without the tool

`transferToAgent` is the function the tool runs. Call it from your own tool
when you want the hand-off but not the declaration.

```ts
import {FunctionTool, transferToAgent} from '@google/adk';
import {z} from 'zod';

const escalate = new FunctionTool({
  name: 'escalate',
  description: 'Send the conversation to the billing agent.',
  parameters: z.object({}),
  execute: (_input, toolContext) =>
    transferToAgent({agentName: 'billing_agent'}, toolContext),
});
```

It records the target on `toolContext.actions.transferToAgent` and returns
`'Transfer queued'`. It throws `toolContext is required.` when there is no
context to record the hand-off on.
