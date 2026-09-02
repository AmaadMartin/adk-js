# SingleFlow and AutoFlow

A flow is the ordered list of processors that build one LLM request. `SingleFlow` is the pipeline for an agent that considers only itself and its tools. `AutoFlow` is the same pipeline plus agent transfer. Reach for them when you build a custom agent runtime and want the standard pipeline, instead of copying the processor order by hand.

## Introduction

Every `LlmAgent` turn runs a list of request processors before it calls the model. Each processor mutates the `LlmRequest`: one resolves the model config, one adds the system instruction, one assembles the conversation contents, one filters the tool list. The order matters, because later processors read what earlier ones wrote. Code execution rewrites the contents, so it must run after the processor that assembles them.

`AutoFlow` adds one more processor at the end, `AgentTransferLlmRequestProcessor`. That processor lists the agents this agent may hand control to, and it declares the `transfer_to_agent` tool. Transfer runs in three directions: from a parent to one of its sub-agents, from a sub-agent back to its parent, and from a sub-agent to one of its peers. The peer case applies only when the parent is itself an `LlmAgent` and `disallowTransferToPeers` is false.

`LlmAgent` picks the flow for you. An agent with no sub-agents that sets both `disallowTransferToParent` and `disallowTransferToPeers` gets `SingleFlow`, because it can never transfer. Every other agent gets `AutoFlow`. You do not construct a flow to use an agent; you construct one when you drive the processors yourself, or when you want to assert what the pipeline contains.

## Get started

```ts
import {AutoFlow, SingleFlow} from '@google/adk';

const auto = new AutoFlow();
const single = new SingleFlow();

// AutoFlow is SingleFlow with the transfer processor appended.
auto.requestProcessors.length === single.requestProcessors.length + 1;
```

The same selection an `LlmAgent` makes:

```ts
import {LlmAgent} from '@google/adk';

const child = new LlmAgent({name: 'child'});
const parent = new LlmAgent({name: 'parent', subAgents: [child]});

// parent has a sub-agent, so its pipeline ends with agent transfer.
parent.requestProcessors.length; // 11

const leaf = new LlmAgent({
  name: 'leaf',
  disallowTransferToParent: true,
  disallowTransferToPeers: true,
});

// leaf can never transfer, so it gets the plain pipeline.
leaf.requestProcessors.length; // 10
```

## What a flow contains

`SingleFlow.requestProcessors`, in order:

1. `BASIC_LLM_REQUEST_PROCESSOR` — model name, generation config, output schema.
2. `AUTH_PREPROCESSOR` — resolves credentials a tool asked for.
3. `IDENTITY_LLM_REQUEST_PROCESSOR` — the agent's name and description.
4. `INSTRUCTIONS_LLM_REQUEST_PROCESSOR` — the system instruction.
5. `REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR` — pending tool confirmations.
6. `REQUEST_INPUT_LLM_REQUEST_PROCESSOR` — pending user input requests.
7. `CONTENT_REQUEST_PROCESSOR` — the conversation contents.
8. `INTERACTIONS_REQUEST_PROCESSOR` — recorded interactions.
9. `CODE_EXECUTION_REQUEST_PROCESSOR` — rewrites contents for the code executor.
10. `TOOL_FILTER_REQUEST_PROCESSOR` — drops tools the agent may not use here.

`AutoFlow` appends `AgentTransferLlmRequestProcessor` as element 11.

`responseProcessors` is empty on both flows.

## Context compaction

Pass compactors to insert a `ContextCompactorRequestProcessor` immediately before `CONTENT_REQUEST_PROCESSOR`. Compaction rewrites the session history that the contents come from, so it has to run first.

```ts
import {AutoFlow, BaseContextCompactor} from '@google/adk';

const compactor: BaseContextCompactor = {
  shouldCompact: (ctx) => ctx.session.events.length > 100,
  compact: (ctx) => {
    ctx.session.events = ctx.session.events.slice(-50);
  },
};

const flow = new AutoFlow([compactor]);
flow.requestProcessors.length; // 12
```

An empty array, or no argument, inserts no compaction processor.

## Guarantees

- Each instance owns its arrays. Appending to one flow's `requestProcessors` never affects another.
- `AutoFlow` adds exactly one processor to `SingleFlow`'s list, at the end.
- `AutoFlow` adds nothing to `responseProcessors`.
- Neither constructor validates its input, performs I/O, or throws.
