# AgentTool

Exposes one agent to another agent as a callable tool. The calling model sees a
function declaration built from the wrapped agent's input schema, and the tool
returns whatever the wrapped agent replies with.

## Introduction

`AgentTool` runs the wrapped agent in its own `Runner`, on the caller's session
service, and returns its final text to the calling agent as a tool result. Reach
for it when a specialist agent — a search agent, a summariser, a translator —
should stay a separate agent with its own instruction and tools, but the caller
must decide when to invoke it.

The wrapped agent's schemas drive the contract. An `inputSchema` becomes the
tool's parameters, and the arguments the model produces are validated against it
before the wrapped agent starts. An `outputSchema` makes the tool return a
parsed object instead of text, validated against that schema. A composite agent
(`SequentialAgent` and friends) has no schemas of its own, so the input schema is
taken from its first sub-agent and the output schema from its last, recursively.

`AgentTool` is not the only way to delegate. A `subAgents` transfer hands the
conversation over to another agent, and the caller does not get the reply back as
a tool result. Use `AgentTool` when the caller must keep control of the turn.

## Get started

```ts
import {AgentTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

const search = new LlmAgent({
  name: 'search_agent',
  model: 'gemini-2.5-flash',
  description: 'Searches the product catalogue.',
  instruction: 'Search the catalogue and report what you find.',
  inputSchema: z.object({query: z.string(), limit: z.number()}),
  outputSchema: z.object({summary: z.string(), count: z.number()}),
});

const assistant = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  instruction: 'Use search_agent to answer product questions.',
  tools: [new AgentTool({agent: search})],
});
```

The assistant's model sees a `search_agent` function taking `query` and `limit`.
A call with a missing or mistyped field is rejected before `search_agent` runs.
A well-formed call returns `{summary, count}` as an object.

## Configuration

```ts
new AgentTool({
  agent: search,
  skipSummarization: true, // Return the reply verbatim.
  includePlugins: false, // Run the wrapped agent without the caller's plugins.
  propagateGroundingMetadata: true, // Publish grounding metadata to state.
});
```

`includePlugins` defaults to true, so the caller's plugins also observe the
wrapped agent's run. The wrapped agent's runner never closes those plugins; the
caller keeps ownership of them.

`propagateGroundingMetadata` defaults to false. When it is on and the wrapped
agent produced grounding metadata, the tool writes it to the caller's state under
`temp:_adk_grounding_metadata`. The `temp:` prefix scopes it to the invocation,
so it is not persisted with the session.

## What the tool returns

The reply is built from the last event that carried content. Thought parts are
dropped. Each remaining part contributes its text, or the output of a code
execution result, or the executable code, and the pieces are joined with
newlines.

| Case                                                    | Result                                                    |
| ------------------------------------------------------- | --------------------------------------------------------- |
| The wrapped agent declares an `outputSchema`            | The reply parsed as JSON and validated against the schema |
| No `outputSchema`                                       | The merged text                                           |
| No event carried content                                | The last error message, or an empty string                |
| The merged text is empty and an event reported an error | That error message                                        |

A reply that is wrapped in a markdown code fence is unfenced before it is parsed,
which a model asked for structured output sometimes produces.

## Failure modes

Validation errors are thrown, not returned. Arguments that violate the input
schema reject before the wrapped agent's runner is built, so no model call is
made. A reply that is not JSON, or that violates the output schema, rejects after
the run. The framework turns both into a tool error response for the calling
model.

A wrapped agent that fails without producing content no longer looks like an
empty answer: the tool returns the error message from the failing event.
