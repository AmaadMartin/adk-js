# The default model

An agent that sets no `model` normally cannot run. `LlmAgent.setDefaultModel`
names the model such an agent uses, and `adk run --default_llm_model` sets it
from the command line. Reach for it when you want to choose the model at run
time instead of editing the agent's source.

## Introduction

`LlmAgent.canonicalModel` resolves the model for one agent. It reads the
agent's own `model` first, then walks up the parent chain to the nearest
ancestor that sets one. When neither supplies a model the getter throws
`No model found for <name>.`.

That is a sound default for a library, and a poor one for a command line. A
person comparing two models has to edit the agent file between runs, and an
agent written without a model cannot be run at all. The default model adds one
more step to the end of the resolution chain, so the caller can supply the
model the author left out.

It is deliberately last. An agent that sets its own model, or inherits one from
an ancestor, is unaffected. The default is also process-wide: it is one value
for the whole runtime, which suits an entry point such as the CLI and does not
suit library code. ADK sets no default of its own, so an agent with no model
and no override still throws, as it always has.

## Get started

Run an agent that sets no model:

```bash
adk run ./agent.ts --default_llm_model gemini-2.5-flash
```

Without the flag the same command reports
`Turn failed: No model found for <name>.`.

The same thing from code:

```ts
import {LlmAgent} from '@google/adk';

LlmAgent.setDefaultModel('gemini-2.5-flash');

const agent = new LlmAgent({name: 'assistant'});
agent.canonicalModel.model; // 'gemini-2.5-flash'
```

The value is read when `canonicalModel` runs, not when the agent is built, so
you may set it before or after you construct the agent.

## Resolution order

`canonicalModel` returns the first of these that exists:

1. The agent's own `model`.
2. The `model` of the nearest ancestor agent that sets one.
3. The default model.

A leaf agent under a parent with `model: 'gemini-2.5-pro'` therefore runs on
`gemini-2.5-pro`, whatever the default is.

## Passing an instance

`setDefaultModel` takes a model name or a `BaseLlm`. A name is resolved through
`LLMRegistry`, which builds a new instance per call. Pass an instance when you
have already configured a client and want every model-less agent to share it:

```ts
import {Gemini, LlmAgent} from '@google/adk';

LlmAgent.setDefaultModel(new Gemini({model: 'gemini-2.5-flash'}));
```

`canonicalModel` returns that exact instance.

## Clearing and errors

`LlmAgent.setDefaultModel(undefined)` removes the override, and a model-less
agent throws again. Clear it in test teardown: the value is process-wide, so it
otherwise decides the model for unrelated agents in the same worker.

| Input                     | Result                                               |
| ------------------------- | ---------------------------------------------------- |
| `''`                      | throws `Default model must be a non-empty string.`   |
| a name no provider claims | `LLMRegistry` throws `Model <name> not found.`       |
| nothing set               | `canonicalModel` throws `No model found for <name>.` |
