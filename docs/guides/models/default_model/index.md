# The default model

An `LlmAgent` with no `model` of its own still runs: it resolves the default
model. `LlmAgent.setDefaultModel` moves that default for the whole process, and
live sessions resolve their own default separately.

## Introduction

An agent names its model as a string, or holds a `BaseLlm` instance. Neither is
mandatory. Resolution runs in this order, and stops at the first step that
produces a model.

1. An explicit `BaseLlm` instance on `LlmAgent.model`.
2. A non-empty model name on `LlmAgent.model`.
3. The nearest `LlmAgent` ancestor. A non-`LlmAgent` ancestor, such as a
   `SequentialAgent`, does not stop the walk.
4. The effective default.

Step 3 is why a sub-agent tree normally states its model once, at the root. Step
4 is `LlmAgent.DEFAULT_MODEL` until `LlmAgent.setDefaultModel` replaces it,
which is how you point a test suite, a local experiment, or a deployment at one
model without editing each agent.

Live mode resolves separately, through `canonicalLiveModel` and
`LlmAgent.DEFAULT_LIVE_MODEL`. The model that serves turn-by-turn requests is
not the model that serves a Live API session, so one default cannot serve both.
Steps 1 to 3 are shared: an agent that states a model uses that model in both
modes.

## Get started

The shortest agent that runs. It states a name and an instruction only.

```ts
import {LlmAgent} from '@google/adk';

const agent = new LlmAgent({name: 'helper', instruction: 'Be helpful.'});

agent.canonicalModel.model === LlmAgent.DEFAULT_MODEL; // true
```

## Moving the default

`setDefaultModel` accepts a model name or a `BaseLlm` instance. An instance
skips the registry, which is what a test wants: it needs no credentials and
reaches no network.

```ts
import {Gemini, LlmAgent} from '@google/adk';

LlmAgent.setDefaultModel('gemini-2.5-flash');
LlmAgent.setDefaultModel(new Gemini({model: 'gemini-2.5-pro'}));
```

`setDefaultLiveModel` does the same for live mode. The two defaults are
independent: setting one leaves the other alone.

```ts
import {LlmAgent} from '@google/adk';

LlmAgent.setDefaultLiveModel('gemini-2.0-flash-live-001');

const agent = new LlmAgent({name: 'helper'});
agent.canonicalLiveModel.model; // 'gemini-2.0-flash-live-001'
agent.canonicalModel.model; // still the turn-by-turn default
```

Both setters change process-wide state. A test that calls one must restore the
previous value afterwards, or the change leaks into every later test in the
same worker:

```ts
afterEach(() => {
  LlmAgent.setDefaultModel(LlmAgent.DEFAULT_MODEL);
  LlmAgent.setDefaultLiveModel(LlmAgent.DEFAULT_LIVE_MODEL);
});
```

## Failure modes

- A setter throws for an empty name: `Default model must be a non-empty model
name or a BaseLlm instance.` It does not check the name against the registry,
  so a typo surfaces later, at resolution.
- Resolving a name no registered model matches throws `Model <name> not found.`
  from `LLMRegistry`.
- Constructing a `Gemini` requires a credential. A model-less agent in a process
  with no API key and no Vertex AI configuration therefore throws when it
  resolves the default, because the built-in defaults are Gemini names. Pass a
  `BaseLlm` instance to `setDefaultModel` to resolve without one.
- `canonicalModel` and `canonicalLiveModel` construct a new instance on every
  read when the model is a name. Hold a `BaseLlm` instance if you need one
  object.
