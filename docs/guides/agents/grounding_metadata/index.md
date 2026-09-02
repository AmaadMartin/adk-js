# Grounding metadata on an agent's response

An `LlmAgent` that searches through a nested search agent produces its answer in
one place and its citations in another. This page explains how the flow brings
the two back together, and what you must provide for it to happen.

## Introduction

A built-in search tool returns grounding metadata: the queries it ran and the
web pages it used. When the search runs inside the same model call as the
answer, the model returns both together and there is nothing to do. When the
search runs in a _nested_ agent, the metadata belongs to the nested agent's
response, and the parent's response carries only the text. A client that renders
citations from `event.groundingMetadata` then shows none.

The flow closes that gap in its after-model stage. The nested search agent tool
writes its metadata to the session state key
`temp:_adk_grounding_metadata`. After the model answers, the flow copies that
value onto the response the parent agent is about to return. The `temp:` prefix
keeps the value out of the persisted session, so it lives only for the
invocation that produced it.

Two conditions gate the copy, and both must hold:

1. The agent resolved a tool named `google_search_agent` for the step in
   flight.
2. The session state holds a value under `temp:_adk_grounding_metadata`.

The metadata lands on whichever response the flow returns. If an after-model
callback or a plugin replaced the model's response, the metadata goes on the
replacement, not on the discarded original.

Write the key through `state.set`, not by index assignment. `state` is a
`State` object that records a delta for the session service, so an index
assignment writes a property nobody reads.

This mirrors `_maybe_add_grounding_metadata` in the Python ADK
`src/google/adk/flows/llm_flows/base_llm_flow.py`.

Note that adk-js does not yet ship the search agent tool itself, nor the writer
of the state key. Until it does, both sides are yours to supply: name your own
tool `google_search_agent` and write the metadata to the state key.

## Get started

```ts
import {FunctionTool, InMemoryRunner, LlmAgent} from '@google/adk';

// Stands in for the nested search agent. Its name is what the flow looks for,
// and it is what writes the metadata the flow later copies.
const searchAgentTool = new FunctionTool({
  name: 'google_search_agent',
  description: 'Answers a question by searching the web.',
  execute: async (_args, toolContext) => {
    toolContext?.state.set('temp:_adk_grounding_metadata', {
      webSearchQueries: ['what is adk'],
    });
    return 'ADK is the Agent Development Kit.';
  },
});

const agent = new LlmAgent({
  name: 'research_agent',
  model: 'gemini-2.0-flash',
  tools: [searchAgentTool],
});

const runner = new InMemoryRunner({agent, appName: 'research_app'});
const session = await runner.sessionService.createSession({
  appName: 'research_app',
  userId: 'user_1',
});

for await (const event of runner.runAsync({
  userId: session.userId,
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'What is ADK?'}]},
})) {
  const queries = event.groundingMetadata?.webSearchQueries;
  if (queries) {
    // Render the citations for this response.
  }
}
```

The tool writes the state key on the turn that calls it, so the flow copies the
metadata onto the response of the _next_ model call — the one that summarises
the tool's result.

## The tool cache the check reads

The check does not re-resolve the agent's tools. Each step stores the tools it
resolved on `InvocationContext.canonicalToolsCache`, flattened across tool
unions, before it calls the model. The after-model stage reads that list.

This matters when a toolset is dynamic. A toolset's `getTools` may return a
different set on the next step, so a fresh resolution could report a tool the
request never carried. Reading the cache keeps the answer consistent with the
request that produced the response.

The cache is refreshed on every step, and is set to an empty list for an agent
with no tools. It is `undefined` only before the first step resolves, in which
case no metadata is added.

## What is not checked

The value under the state key is used as-is when it is an object. The framework
writes this key, so the flow checks only that the value is an object and not
`null`; it does not validate the fields of `GroundingMetadata`. A string, a
number or `null` under that key is ignored.
