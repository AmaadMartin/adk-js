# GoogleSearchTool

Grounds an agent's answers in Google Search. The model runs the search itself,
so the tool only attaches a `googleSearch` entry to the request. Reach for it
when the agent must answer from current web information.

## Introduction

`GoogleSearchTool` is a server-side built-in tool. Unlike a `FunctionTool`, it
never executes locally: `runAsync` resolves immediately, and the work happens
inside the model. The tool's only job is `processLlmRequest`, which appends the
search entry to `llmRequest.config.tools`.

Only Gemini models accept that entry, so the tool validates the model id and
throws for anything else. Two constructor options control the edges of that
behaviour: `model` pins the model the tool validates and sends to, and
`bypassMultiToolsLimit` lifts the Gemini 1.x restriction on combining search
with other tools. The `GOOGLE_SEARCH` singleton is a zero-option instance, which
is what most agents want.

## Get started

Attach the singleton to an agent.

```ts
import {GOOGLE_SEARCH, LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  model: 'gemini-2.5-flash',
  name: 'root_agent',
  description: 'Answers questions from Google Search results.',
  instruction: 'Search Google, then answer from the results.',
  tools: [GOOGLE_SEARCH],
});
```

## Options

Construct the tool yourself when you need either option.

```ts
import {GoogleSearchTool} from '@google/adk';

// Run the search turn on a specific model, whatever model the agent uses.
const pinned = new GoogleSearchTool({model: 'gemini-2.5-flash-lite'});

// Allow the tool beside other tools on a Gemini 1.x model.
const combined = new GoogleSearchTool({bypassMultiToolsLimit: true});
```

`model` replaces `llmRequest.model` before validation, so the tool validates the
model you pinned rather than the agent's model.

`bypassMultiToolsLimit` defaults to `false`. It only affects Gemini 1.x
requests: those accept `googleSearchRetrieval` alone, and the tool throws when
the request already carries other tools. Gemini 2 and later have no such limit.

## Model validation

The tool appends `{googleSearch: {}}` for a Gemini 2+ model id, and
`{googleSearchRetrieval: {}}` for a Gemini 1.x id. It accepts both the plain
form (`gemini-2.5-flash`) and the publisher path form
(`projects/<project>/locations/<location>/publishers/google/models/gemini-2.5-flash`).

Any other model id throws `Google search tool is not supported for model
<model>`. An unset or empty `llmRequest.model` throws the same error. In a
normal agent turn the request processor fills the model in from the agent, so
this error means a direct call with a misconfigured request.

Set `ADK_DISABLE_GEMINI_MODEL_ID_CHECK` to `true` or `1` to accept a non-public
Gemini model id. The tool reads the variable on every call and then appends
`{googleSearch: {}}` instead of throwing.
