# AppDetails

`AppDetails` is the eval system's projection of a running app: which agents it
holds, the instructions each was given, and the tools each declared. Reach for
it when you score a recorded run, because the evaluator reads the projection
instead of the live agent tree.

## Introduction

An evaluator runs after the agent does. The agent tree that produced the run may
be gone, and rebuilding it to read one instruction string is expensive and
inexact. So the eval system records a projection alongside the invocation and
grades against that. A tool-trajectory metric needs the tools the agent was
offered. A judge prompt needs the developer instructions the agent ran under.
Both come off `AppDetails`.

The projection holds two levels. `AppDetails.agentDetails` maps an agent name to
its `AgentDetails`, and `AgentDetails` carries the agent's `name`, its
`instructions` and its `toolDeclarations`.

adk-python declares the two accessors as methods on its `AppDetails` model. A
TypeScript interface holds no methods, so they are exported functions here that
take the app details as their first argument. This follows `eval_case`, the
sibling data model in the same module.

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

Both fields on `AgentDetails` are optional, where adk-python defaults them to
`""` and `[]`. The accessors apply the same defaults, so an agent that declares
neither still reads cleanly.

- `getDeveloperInstructions` returns `''` for an agent that omits
  `instructions`.
- `getToolsByAgentName` returns `[]` for an agent that omits
  `toolDeclarations`. Every agent keeps an entry, including the agents that
  declare no tool.

`getToolsByAgentName` returns the caller's own arrays, not copies. Mutating a
returned list mutates the projection.

## Failure modes

`getDeveloperInstructions` throws a `NotFoundError` when the app holds no agent
under that name. The message names the agent in backticks, matching adk-python.

```ts
import {getDeveloperInstructions} from '@google/adk';

getDeveloperInstructions(appDetails, 'planner');
// NotFoundError: `planner` not found in the agentic system.
```

An app with no `agentDetails` at all behaves as an app with no agents: the
lookup throws `NotFoundError`, and `getToolsByAgentName` returns `{}`.

The lookup only sees agents the app declares. An inherited key such as
`toString` or `constructor` is not an agent name, so it throws like any other
unknown name.
