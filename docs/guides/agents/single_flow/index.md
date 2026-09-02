# SingleFlow

`SingleFlow` is the standard processor pipeline for an agent that considers only
itself and its tools. It builds the ordered list of request processors and
response processors that `LlmAgent` runs on every turn. Reach for it when you
want the default pipeline plus a processor of your own, or when you need to know
what runs before what.

## Introduction

Every turn an `LlmAgent` takes has two pipelines. Request processors build the
`LlmRequest` before the model sees it: they set the model and the generation
config, resolve auth, add the instruction and the identity preamble, assemble
the conversation contents, and filter the tool list. Response processors inspect
the `LlmResponse` afterwards.

The order is behaviour, not style. The code execution processor rewrites the
contents that the content processor assembled, so it must run after it. A
compactor rewrites the event history that those contents come from, so it must
run before. The interactions processor reads the chain id before the contents
are built, because a chained request only needs the current turn.

`SingleFlow` owns that order, so it is one named contract with tests rather than
a literal inside a constructor. `LlmAgent` uses it for its defaults. Transfer to
another agent is not part of it: `LlmAgent` appends
`AGENT_TRANSFER_LLM_REQUEST_PROCESSOR` itself when the agent has sub-agents or
may transfer to a parent or a peer.

Each instance gets its own arrays. Appending to one flow's list changes nothing
for any other agent.

## Get started

An `LlmAgent` builds its pipeline from `SingleFlow` with no work from you.

```ts
import {LlmAgent} from '@google/adk';

// requestProcessors is the SingleFlow list; responseProcessors is its
// response list.
const agent = new LlmAgent({name: 'assistant', model: 'gemini-2.5-flash'});
```

To run the standard pipeline plus one processor of your own, build the flow,
append to it, and pass the list to the agent.

```ts
import {LlmAgent, SingleFlow} from '@google/adk';
import {MY_REQUEST_PROCESSOR} from './my_request_processor.js';

const flow = new SingleFlow();
flow.requestProcessors.push(MY_REQUEST_PROCESSOR);

const agent = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  requestProcessors: flow.requestProcessors,
});
```

## The pipeline

`requestProcessors`, in the order they run:

1. `BASIC_LLM_REQUEST_PROCESSOR` — the model, the generation config, the output
   schema when the model accepts one.
2. `AUTH_PREPROCESSOR` — resolves credentials that a tool asked for on an
   earlier turn.
3. `REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR` — replays a tool confirmation.
4. `REQUEST_INPUT_LLM_REQUEST_PROCESSOR` — replays an answer to a request for
   input.
5. `INSTRUCTIONS_LLM_REQUEST_PROCESSOR` — the global and agent instructions.
6. `IDENTITY_LLM_REQUEST_PROCESSOR` — the agent name and description preamble.
7. `INTERACTIONS_REQUEST_PROCESSOR` — the Interactions chain id, read before the
   contents.
8. `ContextCompactorRequestProcessor` — present only when you pass compactors.
9. `CONTENT_REQUEST_PROCESSOR` — the conversation contents.
10. `CODE_EXECUTION_REQUEST_PROCESSOR` — rewrites the contents to optimize data
    files.
11. `TOOL_FILTER_REQUEST_PROCESSOR` — narrows the tool list.
12. `OUTPUT_SCHEMA_REQUEST_PROCESSOR` — the `set_model_response` workaround.

`responseProcessors` holds the code execution response processor, which runs the
code the model emitted.

## Context compaction

Pass compactors to the constructor and a `ContextCompactorRequestProcessor` is
inserted immediately before the contents processor, so the compacted history is
what the model sees. An empty list and no argument both mean no compaction.

```ts
import {LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  contextCompactors: [myCompactor],
});
```

`LlmAgent` passes its `contextCompactors` option straight to `SingleFlow`. A
caller-supplied `requestProcessors` list replaces the whole pipeline, compaction
included, so build the list from `new SingleFlow([myCompactor])` if you need
both.

## Structured output alongside tools

Some models cannot accept an output schema and a tool list in the same request.
`OUTPUT_SCHEMA_REQUEST_PROCESSOR` closes that gap. When the agent has an
`outputSchema` and at least one tool, and the model cannot pair the two, it adds
a `set_model_response` tool whose parameters are the output schema, plus one
instruction telling the model to answer through that tool. On a model that
accepts both, and for an agent in `task` mode, it leaves the request untouched.
