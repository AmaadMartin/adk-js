# TransferToAgentTool

`TransferToAgentTool` is the tool a model calls to hand control to another
agent. It tells the model exactly which agents exist, and it can ask the model
to state why it is handing off. Reach for it when you build an `LlmRequest`
yourself; a plain `LlmAgent` already gets it from the agent transfer processor.

## Introduction

A multi-agent app needs a way for the model to say "another agent should answer
this". ADK does that with a function call named `transfer_to_agent`. The call
does not run the other agent. It records the target on the event actions, and
the runner performs the hand-off after the turn.

The tool constrains the target. Its declaration carries a JSON-Schema `enum` of
the agent names you pass to the constructor, so a model that follows the schema
cannot name an agent that does not exist. The constraint is a hint to the model
and not a run-time check: an unknown name still reaches the tool, is recorded,
and fails later in the hand-off.

`AgentTransferLlmRequestProcessor` builds this tool for you on every turn of an
`LlmAgent` that has reachable transfer targets. It passes the sub-agents, the
parent agent and the peers that the agent may transfer to. You only construct
the tool yourself when you assemble a request outside that processor.

## Get started

```ts
import {TransferToAgentTool} from '@google/adk';

const tool = new TransferToAgentTool({agentNames: ['billing', 'support']});
```

The declaration the model sees offers one parameter, restricted to those two
names:

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
        "enum": ["billing", "support"]
      }
    },
    "required": ["agentName"]
  }
}
```

When the model calls it, the tool records the target and returns
`'Transfer queued'`:

```ts
await tool.runAsync({args: {agentName: 'billing'}, toolContext});

toolContext.actions.transferToAgent; // 'billing'
```

## Ask the model why it transfers

Set `includeTransferReason` to add an optional `transferReason` parameter. Use
it when you want to log or audit the hand-off decision:

```ts
const tool = new TransferToAgentTool({
  agentNames: ['billing', 'support'],
  includeTransferReason: true,
});

await tool.runAsync({
  args: {agentName: 'billing', transferReason: 'refund request'},
  toolContext,
});

toolContext.actions.transferReason; // 'refund request'
```

The reason lands on `EventActions.transferReason`, next to the target agent, so
it travels with the event and survives a merge of several event actions.

The option changes only what the model is offered. Without it the declaration
has no `transferReason` property and the description does not mention one. The
tool function accepts a reason either way, and `agentName` stays required in
both modes while `transferReason` is always optional.

An empty reason counts as no reason: `transferReason: ''` leaves
`actions.transferReason` undefined rather than storing an empty string.

## Failure modes

- A call with no tool context throws `toolContext is required.`, wrapped by
  `FunctionTool` as `Error in tool 'transfer_to_agent': ...`.
- A call whose `agentName` is missing or is not a string is rejected by the
  parameter schema before the tool runs, and the event actions stay unset.
- A call naming an agent outside the enum is not an error here. It is recorded
  and fails later, when the runner looks for that agent.
