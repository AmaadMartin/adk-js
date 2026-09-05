# Plugin agent callbacks

A plugin sees every agent in a run through three hooks: `beforeAgentCallback`,
`afterAgentCallback` and `onAgentErrorCallback`. Reach for them when you want
one piece of logic — tracing, an access check, error reporting — to apply to a
whole agent tree instead of to one agent.

## Introduction

An agent can carry its own `beforeAgentCallback` and `afterAgentCallback`. Those
are per-agent: you attach them when you build the agent, and adding a fourth
agent means attaching them a fourth time. A plugin is registered once on the
runner and applies to every agent that runner drives, including sub-agents.

`BaseAgent` asks the plugins first. If a plugin's `beforeAgentCallback` returns
content, the agent's own callbacks are skipped, the agent's body does not run,
and that content becomes the single event of the run. If every plugin returns
`undefined`, the agent's own callbacks run as usual. `afterAgentCallback` has
the same precedence, but its content is appended rather than substituted, and it
does not end the invocation.

`onAgentErrorCallback` is different in kind. It only notifies: the agent
re-throws the original error after every plugin has been told, so a plugin
cannot swallow a failure or replace it with a result. It fires for anything that
escapes the agent, including a failure inside a lifecycle callback, and it does
not fire when the invocation was aborted. A plugin that throws inside this hook
is logged and skipped, so a broken reporter cannot hide the error it reports.

## Get started

Register the plugin on the runner. Every agent under that runner reaches it.

```ts
import {
  BaseAgent,
  BasePlugin,
  Context,
  InMemoryRunner,
  LlmAgent,
} from '@google/adk';
import {Content} from '@google/genai';

/** Records the agents a run started, and the ones that failed. */
class AuditPlugin extends BasePlugin {
  readonly started: string[] = [];
  readonly failed: Array<{agent: string; message: string}> = [];

  override async beforeAgentCallback({
    agent,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    this.started.push(agent.name);
    return undefined;
  }

  override async onAgentErrorCallback({
    agent,
    error,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
    error: Error;
  }): Promise<void> {
    this.failed.push({agent: agent.name, message: error.message});
  }
}

const audit = new AuditPlugin('audit');
const runner = new InMemoryRunner({
  agent: new LlmAgent({name: 'assistant', model: 'gemini-2.5-flash'}),
  plugins: [audit],
});
```

`AuditPlugin` returns `undefined` from `beforeAgentCallback`, so the agent runs
normally. Return a `Content` instead to answer without running the agent:

```ts
class MaintenancePlugin extends BasePlugin {
  override async beforeAgentCallback({
    agent,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    if (agent.name !== 'assistant') {
      return undefined;
    }
    return {role: 'model', parts: [{text: 'The assistant is offline.'}]};
  }
}
```

## Guarantees

- Plugins run in registration order. The first plugin to return content wins,
  and later plugins are not called for that hook.
- The agent's own callbacks run only when no plugin returned content.
- `onAgentErrorCallback` reaches every registered plugin. One plugin's failure
  does not stop the rest, and its return value cannot stop them either.
- The error the caller catches is the object the agent threw, unchanged.
- A thrown value that is not an `Error` is wrapped before it reaches the hook,
  so `error` is always an `Error`.

## Related agent behaviour

Two `BaseAgent` checks are easy to trip over while wiring an agent tree.

`clone()` rejects an override key the agent cannot place, so a typo fails
instead of returning an unchanged copy:

```ts
agent.clone({instrction: 'be brief'});
// Error: Cannot update nonexistent fields in LlmAgent: instrction
```

Two sub-agents with the same name log a warning at construction. The tree still
builds, but `findSubAgent` returns whichever agent comes first:

```text
Found duplicate sub-agent names: `search`. All sub-agents must have unique names.
```
