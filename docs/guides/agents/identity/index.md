# Agent Identity

Every `LlmAgent` request carries a short system instruction that tells the model
its own name, and its description when one is set. The framework adds it for
you. Read this guide when you need to know what the model is told about the
agent, or when you want an agent that is not told anything.

---

## Introduction

An agent can hand a conversation to another agent. The model has to name the
agent it is handing over from, and it has to recognise itself in a transcript
that contains several agents. `IdentityLlmRequestProcessor` supplies that name.
It runs third in the default request processor chain of `LlmAgent`, before the
processor that adds your own `instruction`, so the identity line always comes
first in the system prompt.

The processor reads only the agent's `name` and `description`. It does not read
session state, and it adds no events. The description it emits is the same
string that the parent agent sees when it chooses a transfer target, so one
description serves both readers: write it as a statement of what the agent
does.

---

## Get started

Give the agent a name and a description. The framework does the rest.

```ts
import {LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'weather_agent',
  model: 'gemini-2.5-flash',
  description: 'Answers questions about the weather.',
  instruction: 'Be concise.',
});
```

The model receives this system instruction:

```
You are an agent. Your internal name is "weather_agent". The description about you is "Answers questions about the weather.".

Be concise.
```

With no description, the identity line stops after the name:

```
You are an agent. Your internal name is "weather_agent".
```

---

## The instruction is one string

The name and the description form a single sentence-joined string, and the
description keeps a trailing period. Your own `instruction` is appended after a
blank line, by a later processor.

An agent whose transfers are disabled still gets the identity line. So does an
agent with an `outputSchema`, which disables both transfer directions.

---

## Single-turn agents get no identity

An agent in `single_turn` mode answers one isolated input and never transfers
control, so the processor adds nothing at all:

```ts
const classifier = new LlmAgent({
  name: 'classifier',
  model: 'gemini-2.5-flash',
  mode: 'single_turn',
  instruction: 'Reply with one of: bug, feature, question.',
});
```

The system instruction is then just `Reply with one of: bug, feature,
question.`.

The check is on the literal value `'single_turn'`. An agent that leaves `mode`
unset gets the identity line, even when a workflow runs it as a node.
