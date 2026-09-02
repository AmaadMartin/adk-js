# SingleFlow and BaseLlmFlow

`SingleFlow` is the request and response processor pipeline that an `LlmAgent`
runs by default. It covers an agent that considers only itself and its tools.
Reach for it when you want to read the default pipeline, reorder it, or build a
variant of it.

## Introduction

Before ADK calls the model it builds an `LlmRequest`: the contents, the system
instruction, the tool declarations, and the generation config. It does that by
running a list of request processors in order. After the model answers, a list
of response processors runs over the `LlmResponse`.

The order of that first list is the contract. Compaction rewrites the history
that the contents processor reads, so it runs immediately before it. Code
execution rewrites the contents the contents processor assembled, so it runs
after it. The output schema processor runs last, so its instruction lands at the
end of the system prompt.

`SingleFlow` names that composition. Without it the list is an anonymous array
inside the `LlmAgent` constructor: nothing outside `LlmAgent` can read it, and
nothing can extend it. `BaseLlmFlow` is the base class it extends. The base
class supplies two empty arrays, and a subclass appends to them from its own
constructor. That is what makes a variant possible: a subclass adds its
processors without restating the ones it inherits.

Each instance owns its arrays, so a change to one flow's list never reaches
another agent.

`SingleFlow` deliberately omits agent transfer. `LlmAgent` appends the transfer
processor itself, when the agent has somewhere to transfer to.

## Get started

Read the default pipeline:

```ts
import {
  CONTENT_REQUEST_PROCESSOR,
  INTERACTIONS_REQUEST_PROCESSOR,
  SingleFlow,
} from '@google/adk';

const {requestProcessors} = new SingleFlow();

// The interactions processor reads the chain id before the contents are built.
const interactionsRunsFirst =
  requestProcessors.indexOf(INTERACTIONS_REQUEST_PROCESSOR) <
  requestProcessors.indexOf(CONTENT_REQUEST_PROCESSOR);
```

Pass the pipeline to an agent explicitly. `LlmAgent` builds the same list when
you pass nothing, so this is the long form of the default:

```ts
import {LlmAgent, SingleFlow} from '@google/adk';

const flow = new SingleFlow();

const agent = new LlmAgent({
  name: 'my_agent',
  model: 'gemini-2.5-flash',
  requestProcessors: flow.requestProcessors,
  responseProcessors: flow.responseProcessors,
});
```

## Adding compaction

`SingleFlow` inserts a compaction processor only when you give it at least one
compactor. `LlmAgent` passes the `contextCompactors` you configured:

```ts
import {
  Gemini,
  LlmAgent,
  LlmSummarizer,
  TokenBasedContextCompactor,
} from '@google/adk';

const agent = new LlmAgent({
  name: 'my_agent',
  model: 'gemini-2.5-flash',
  contextCompactors: [
    new TokenBasedContextCompactor({
      tokenThreshold: 8000,
      eventRetentionSize: 10,
      summarizer: new LlmSummarizer({
        llm: new Gemini({model: 'gemini-2.5-flash'}),
      }),
    }),
  ],
});
```

The compaction processor lands immediately before the contents processor, so
the compacted events are the ones the model sees.

## Building a variant

A subclass calls `super()` and then appends. The inherited arrays already hold
the standard processors, so a variant states only what it adds:

```ts
import {AgentTransferLlmRequestProcessor, SingleFlow} from '@google/adk';

class TransferFlow extends SingleFlow {
  constructor() {
    super();
    this.requestProcessors.push(new AgentTransferLlmRequestProcessor());
  }
}
```

This is the shape adk-python's `AutoFlow` uses. adk-js has no `AutoFlow` class:
`LlmAgent` appends the transfer processor directly.

## Structured output alongside tools

Some models cannot accept an output schema and tool declarations in the same
request. For those, the last processor in the pipeline declares a
`set_model_response` tool whose parameters are the agent's output schema, and
instructs the model to answer by calling it.

It applies only when every one of these holds: the agent has an output schema,
the agent has tools, the model cannot pair the two natively, and the agent is
not in `task` mode. A `task` mode agent completes through `finish_task`
instead. When any condition fails, the processor leaves the request untouched
and the basic processor sets a native response schema instead.

You configure none of this directly. Declaring both an output schema and tools
is enough:

```ts
import {FunctionTool, LlmAgent} from '@google/adk';
import {Type} from '@google/genai';

const agent = new LlmAgent({
  name: 'my_agent',
  model: 'gemini-2.5-flash',
  outputSchema: {
    type: Type.OBJECT,
    properties: {answer: {type: Type.STRING}},
  },
  tools: [
    new FunctionTool({
      name: 'lookup',
      description: 'Looks a value up.',
      execute: () => 'result',
    }),
  ],
});
```
