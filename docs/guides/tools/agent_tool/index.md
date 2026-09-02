# AgentTool

`AgentTool` exposes an agent to another agent as a callable tool. The caller's
model sees a function declaration built from the wrapped agent, calls it with
arguments, and gets the wrapped agent's answer back as the tool result. Reach
for it when a specialist agent should answer one question and hand control
straight back, rather than take over the conversation.

## Introduction

ADK gives a parent agent two ways to involve another agent. Agent transfer hands
the conversation over: the sub-agent becomes the active agent and keeps
answering the user. `AgentTool` does not. The wrapped agent runs once, in its
own nested run, and the parent stays in charge.

That difference decides which one you want. Use transfer when the sub-agent
owns the rest of the conversation. Use `AgentTool` when the parent needs one
answer, from a specialist, in the middle of its own reasoning.

The wrapped agent does not join the caller's run. `AgentTool` builds a `Runner`
for it and performs a separate nested run, then returns the last event's text
as the tool result. Three consequences follow, and each has a section below.
The nested run inherits the caller's `RunConfig`, so a limit the caller set
still applies. Its arguments are validated at the tool boundary when the wrapped
agent declares an input schema. And the sub-runner releases its toolsets when
the run ends, so a toolset the wrapped agent holds does not stay open.

## Get started

```ts
import {AgentTool, InMemoryRunner, LlmAgent} from '@google/adk';

const translator = new LlmAgent({
  name: 'translator',
  model: 'gemini-2.5-flash',
  description: 'Translates a sentence into French.',
  instruction:
    'Translate the request into French. Answer with the translation only.',
});

const assistant = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  description: 'Answers user questions.',
  instruction: 'Use the translator tool whenever the user asks for French.',
  tools: [new AgentTool({agent: translator})],
});
```

The tool's name is the wrapped agent's name, and its description is the wrapped
agent's description. Give the wrapped agent a clear `description`: it is the only
thing the caller's model reads when deciding whether to call the tool.

## Arguments

A wrapped agent with no input schema is declared with one string parameter,
`request`. Its value becomes the message the wrapped agent receives, verbatim —
including an empty string.

A model does not always respect that declaration. When the arguments carry no
string `request`, `AgentTool` sends them as JSON with the keys sorted at every
depth. Two calls with the same arguments therefore produce the same message,
whatever order the model emitted the keys in:

```
{product: 'running shoes', brand: 'Nike'}
  -> {"brand":"Nike","product":"running shoes"}
```

Give the wrapped agent an `inputSchema` when it needs structured arguments:

```ts
import {AgentTool, LlmAgent} from '@google/adk';
import {z} from 'zod';

const search = new LlmAgent({
  name: 'catalogue_search',
  model: 'gemini-2.5-flash',
  description: 'Searches the product catalogue.',
  inputSchema: z.object({query: z.string(), limit: z.number()}),
});

const searchTool = new AgentTool({agent: search});
```

The schema then does two jobs. It becomes the tool declaration's parameters, so
the model is told what to send. And `AgentTool` validates the arguments against
it before the nested run starts. Arguments that violate the schema throw out of
the tool call, which the agent loop reports back to the model as a tool error,
so the model can correct the call. Nothing reaches the wrapped agent.

Validation uses the schema in the form you supplied it. A Zod refinement is
enforced even though the genai schema sent to the model cannot express it.

The validated arguments reach the wrapped agent as a bare JSON document, with
no prose around it, because the wrapped agent parses that text against the same
schema.

## What the sub-agent sees

The nested run is isolated:

- **A new session, every call.** `AgentTool` builds a fresh
  `InMemorySessionService` per call, so the wrapped agent reads neither the
  caller's transcript nor its own previous turns. Two calls in one turn do not
  see each other.
- **The caller's app name.** Session and telemetry backends key on the app name,
  so the nested run is filed under the caller's app, not under the sub-agent's
  own name.
- **A copy of the caller's state**, minus two groups of keys. Keys prefixed
  `temp:` are invocation-scoped and are dropped by the session service. Keys
  prefixed `_adk` are ADK's own bookkeeping and are filtered out before the
  child session is created.

State changes flow back: every state delta the sub-agent's events carry is
applied to the caller's state, again with `temp:` keys removed.

## The nested run config

The nested run uses the caller's `RunConfig`, so a `maxLlmCalls` ceiling, HTTP
options, or metadata the caller set also apply to the wrapped agent. The call
counter is per-invocation, so the ceiling bounds the nested run rather than
being shared with the caller's.

```ts
for await (const event of runner.runAsync({
  userId: session.userId,
  sessionId: session.id,
  newMessage: {role: 'user', parts: [{text: 'Say that in French.'}]},
  runConfig: {maxLlmCalls: 8},
})) {
  // The translator runs under this ceiling too.
}
```

Two settings are overridden, and your own `RunConfig` object is never modified:

- `supportCfc` is forced off. Compositional function calling describes how the
  caller's own model executes. Passing it on switches the wrapped agent to the
  live API path, which only works if its model supports it.
- `streamingMode` is forced to `StreamingMode.NONE`. Only the last nested
  event's content becomes the tool result, so a streamed nested run could leave
  a partial chunk as the answer.

A caller with no `RunConfig` produces a nested run with no `RunConfig`; the
runner applies its own defaults.

## Returning the answer verbatim

Set `skipSummarization: true` when the sub-agent's answer should reach the user
as written, instead of being rewritten by the caller's model:

```ts
new AgentTool({agent: translator, skipSummarization: true});
```

This sets `skipSummarization` on the tool context, which makes the tool-response
event a final response and ends the caller's step loop. The sub-agent's answer is
also appended to that event as a text part, so a user interface that does not
render function responses still shows it. A non-string result is serialized as
JSON. An empty result, and a result reporting an error, append nothing.

## Releasing the sub-runner

`AgentTool` awaits `Runner.closeToolsets()` when the nested run ends — after a
normal run, after an abort, and after the wrapped agent throws. That call
releases the toolsets held by the runner's agent and their sub-agents, so an MCP
session the wrapped agent opened does not outlive the tool call.

It releases nothing else. The session service and the plugins belong to the
caller, which is still using them. `Runner.close()` is the wider call: it
releases the toolsets and then the plugins, so use that one for a runner you own
rather than borrow from.

Both methods are public, so you can call either on a runner of your own. Both
are safe to call more than once: a runner is reusable across runs, and each call
closes the toolsets again.

## Declaring parameters as JSON Schema

`AgentTool` declares its parameters with the genai `Schema` dialect by default.
Enabling the experimental `JSON_SCHEMA_FOR_FUNC_DECL` feature switches the
declaration to plain JSON Schema instead: `parametersJsonSchema` replaces
`parameters`, and off the Gemini API `responseJsonSchema` replaces `response`.

```ts
import {FeatureName, overrideFeatureEnabled} from '@google/adk';

overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);
```

The feature is off by default. It can also be enabled with the
`ADK_ENABLE_JSON_SCHEMA_FOR_FUNC_DECL` environment variable.
