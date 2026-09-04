# AppDetails

`AppDetails` is the eval system's projection of a running app. It records which
agents the app holds, the instructions each agent was given, and the tool
declarations each agent offered. Reach for it when you score a recorded run
rather than a live one.

## Introduction

An evaluator scores an invocation after the run is over. By then the agent tree
is gone: the `LlmAgent` objects, their instructions and their toolsets are no
longer in memory, and a recorded eval case is the only thing left. An evaluator
that wants to know what the agent was told to do therefore cannot read the
agent.

`AppDetails` closes that gap. It is recorded alongside the invocation and holds
only the fields the eval system reads, so it stays small enough to serialize
into an eval set. It is deliberately a projection and not a copy of the app: an
`AppDetails` does not let you run anything.

Two accessors read it. `getDeveloperInstructions` answers "what was this agent
told to do", which a judge prompt needs so it can grade the answer against the
instruction. `getToolsByAgentName` answers "what could this agent have called",
which a judge prompt needs so it can tell an unavailable tool from an unused
one.

`AppDetails` and `AgentDetails` are plain interfaces, so both survive a
`JSON.stringify` and `JSON.parse` round trip. The accessors are module-level
functions rather than methods, because a parsed object has no methods. The
field names are camelCase, matching the aliases adk-python's eval models
serialize with, so both SDKs read the same recorded data.

## Get started

```ts
import {
  AppDetails,
  getDeveloperInstructions,
  getToolsByAgentName,
} from '@google/adk';

const appDetails: AppDetails = {
  agentDetails: {
    root_agent: {
      name: 'root_agent',
      instructions: 'Answer weather questions.',
      toolDeclarations: [{functionDeclarations: [{name: 'get_weather'}]}],
    },
    greeter: {name: 'greeter', instructions: 'Say hello.'},
  },
};

getDeveloperInstructions(appDetails, 'root_agent');
// 'Answer weather questions.'

getToolsByAgentName(appDetails);
// {root_agent: [{functionDeclarations: [{name: 'get_weather'}]}], greeter: []}
```

## Defaults

Both `instructions` and `toolDeclarations` are optional on `AgentDetails`, and
the accessors supply the default:

- `getDeveloperInstructions` returns `''` for an agent that declares no
  instructions.
- `getToolsByAgentName` maps an agent that declares no tools to `[]`. The agent
  keeps its entry in the result, so the number of keys always matches the
  number of agents.

`getToolsByAgentName` returns the declared arrays themselves, not copies. Do
not mutate them.

## Unknown agent

`getDeveloperInstructions` throws when the app holds no agent under that name.
The message names the agent:

```ts
getDeveloperInstructions(appDetails, 'nope');
// Error: `nope` not found in the agentic system.
```

An app with no `agentDetails` at all throws the same way. The check tests own
properties only, so an inherited key such as `'toString'` throws rather than
resolving through `Object.prototype`.
