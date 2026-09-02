# Cloning an agent

`clone()` copies an agent into a new, detached agent you can change without
touching the original. Reach for it when one configured agent has to run in a
second place: a tool that wraps an agent, a workflow that reuses one, or a
variant that differs by a field or two.

## Introduction

A copy is not a shared reference. An agent holds state that a second caller must
not reach — a parent link, a sub-agent list, a request-processor array — so
handing the same instance to two places couples them. `clone()` rebuilds the
agent by running its constructor again with the original config plus your
overrides, which re-derives that state instead of copying an already-used
instance.

Three rules follow from that:

- The clone is a detached root. Its `parentAgent` is always `undefined`, so you
  can add it to a new tree.
- Sub-agents are cloned too, and re-parented to the clone, unless you override
  `subAgents` yourself.
- A list-valued field is shallow-copied, so pushing onto the clone's `tools`
  does not change the original's.

## Get started

```ts
import {LlmAgent} from '@google/adk';

const assistant = new LlmAgent({
  name: 'assistant',
  model: 'gemini-2.5-flash',
  instruction: 'Answer the question.',
});

const terse = assistant.clone({
  name: 'terse_assistant',
  instruction: 'Answer in one sentence.',
});
```

`terse` is an `LlmAgent`, like the agent it came from. `assistant` still carries
its own instruction.

## Callbacks that are the agent's own methods

An agent can use one of its own methods as a lifecycle callback. Such a callback
is rebound to the clone, so it reads and writes the clone rather than the agent
it was copied from:

```ts
import {BaseAgent, BaseAgentConfig, Event} from '@google/adk';
import {Content} from '@google/genai';

class AnnouncingAgent extends BaseAgent {
  constructor(config: BaseAgentConfig) {
    super({
      beforeAgentCallback: AnnouncingAgent.prototype.announce,
      ...config,
    });
  }

  announce(): Content {
    return {role: 'model', parts: [{text: `announced by ${this.name}`}]};
  }

  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {}

  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {}
}

const original = new AnnouncingAgent({name: 'original'});
const copy = original.clone({name: 'copy'});
// copy's callback answers 'announced by copy'.
```

The rebinding works by identity: the callback has to be the same function object
as a method of the agent. A function that was already bound with `bind`, and an
arrow function that closed over the original agent, are left alone, because
JavaScript cannot report what such a function captured. Bind to the clone
yourself if you need that.

Cloning a clone rebinds again, to the newest copy.

## Rejected overrides

An override key the agent cannot place is rejected, so a typo fails instead of
returning a copy that silently ignored it:

```ts
assistant.clone({instrction: 'be brief'});
// Error: Cannot update nonexistent fields in LlmAgent: instrction
```

Overriding `parentAgent` is rejected too. A parent link is set by the parent
when it is built with its sub-agents, never on a clone.
