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
