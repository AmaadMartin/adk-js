# Grounding metadata from a search tool

An `LlmAgent` that owns a tool named `google_search_agent` copies grounding
metadata out of session state onto the response it yields. Reach for this when
a search runs as a tool and the caller still needs the citations that search
produced.

## Introduction

A model that runs `google_search` itself returns `groundingMetadata` on its own
response, and ADK passes it straight through. Nothing here applies to that
case.

The picture changes when the search runs as a tool. The parent's model never
sees a grounded response; it sees a plain tool result, and the citations the
search produced have nowhere to go. The caller loses them.

The search tool closes that gap by writing its metadata into session state
under `temp:_adk_grounding_metadata`. After the next model call, the agent's
flow reads that key and attaches the value to the response it is about to
yield. Two conditions gate it, and both must hold:

1. Some tool the agent resolved this step is named exactly
   `google_search_agent`. The flow matches on the name, not on a class, so you
   can supply your own tool under that name.
2. `temp:_adk_grounding_metadata` holds a non-empty object.

The `temp:` prefix matters. ADK never persists a `temp:` key to the session
service, so the metadata lives for one invocation and does not accumulate.

The flow attaches the metadata after the after-model callbacks run. If a plugin
or an `afterModelCallback` replaced the response, the metadata lands on the
replacement, so a callback cannot lose it by returning a fresh object.

## Get started

One tool can do both jobs: carry the name the flow matches on, and write the
metadata.

```ts
import {FunctionTool, LlmAgent} from '@google/adk';

const searchTool = new FunctionTool({
  name: 'google_search_agent',
  description: 'Answers a question with a web search.',
  execute: async (args, toolContext) => {
    const {answer, groundingMetadata} = await runSearch(args['request']);
    toolContext?.state.set('temp:_adk_grounding_metadata', groundingMetadata);
    return answer;
  },
});

const agent = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  tools: [searchTool],
});
```

The tool result goes back to the model as usual. The response the model then
produces carries `groundingMetadata`, so a caller can render the citations:

```ts
for await (const event of runner.runAsync({userId, sessionId, newMessage})) {
  const chunks = event.groundingMetadata?.groundingChunks ?? [];
  render(chunks.map((chunk) => chunk.web?.uri));
}
```

## Where the metadata can be written from

The writer has to run inside the same invocation as the agent that yields the
response, because the flow reads the invocation's own session state.

A tool, an `afterModelCallback`, or a plugin all qualify. An `AgentTool` does
not: it runs its agent through a separate runner and drops every `temp:` key
from the state it hands back, so a sub-agent cannot populate the key for its
parent.

## What it does not do

The flow copies the metadata; it does not merge or validate it. Two points
follow.

An empty object is ignored. `{}` carries nothing to attach, so the flow leaves
the response alone rather than setting an empty field on it.

The last write wins. The state key holds one value, so a second search in the
same invocation overwrites the first, and every response from that point
carries the newer metadata. Clear the key from a callback if you need a later
turn to report no grounding.

This does not apply to the live path. There the flow reads a response returned
by the after-model callbacks as "the callbacks blocked this turn", so attaching
metadata to a turn nobody blocked would end the turn early.

## Relation to adk-python

This mirrors `_maybe_add_grounding_metadata` in adk-python's
`src/google/adk/flows/llm_flows/base_llm_flow.py`, including the tool name and
the state key. adk-python calls it from `_handle_after_model_callback`, which
its live sites also use; adk-js calls it from the non-live path only, for the
reason given above.
