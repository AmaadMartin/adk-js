# AppDetails

`AppDetails` is the eval system's picture of an agentic app. For each agent it
records the name, the developer instructions, and the tool declarations the
agent had. Reach for it when an evaluator must judge whether an agent followed
its instructions, or used a tool it actually had.

## Introduction

An evaluator scores what an agent produced, but a score is only meaningful next
to what the agent was asked to do. "The agent ignored the instruction" needs the
instruction. "The agent invented a tool" needs the tool list. Both come from the
`LlmRequest` the runner sent, which the evaluator never sees.

`AppDetails` carries that context across the gap. A producer records one
`AppDetails` per invocation while the agent runs. An evaluator reads it later,
possibly in another process, so the record is a plain serializable object with
no behaviour attached. Its field names match the JSON that adk-python writes,
so the two runtimes read each other's eval data.

The three functions are pure. They never mutate the record you pass them, and
they never call out to the app the record describes.

adk-js does not yet ship a producer. You build the `AppDetails` yourself, or you
load one that adk-python recorded.

## Get started

`createAgentDetails` fills the fields you leave out, so an agent with no
instruction and no tool is one short call.

```ts
import {
  AppDetails,
  createAgentDetails,
  getDeveloperInstructions,
  getToolsByAgentName,
} from '@google/adk';

const appDetails: AppDetails = {
  agentDetails: {
    root_agent: createAgentDetails({
      name: 'root_agent',
      instructions: 'You are a helpful travel assistant.',
      toolDeclarations: [{functionDeclarations: [{name: 'search_flights'}]}],
    }),
    booking_agent: createAgentDetails({name: 'booking_agent'}),
  },
};

getDeveloperInstructions(appDetails, 'root_agent');
// 'You are a helpful travel assistant.'

getToolsByAgentName(appDetails);
// {root_agent: [{functionDeclarations: [{name: 'search_flights'}]}],
//  booking_agent: []}
```

## Guarantees

`getDeveloperInstructions` returns a string or throws. It never returns
`undefined`. An agent that omits `instructions` reads back as `''`, which is
the default adk-python applies.

`getToolsByAgentName` returns one entry per agent, including every agent that
declares no tool. It does not omit, filter, or sort. An agent that omits
`toolDeclarations` reads back as `[]`.

## Failure mode

`getDeveloperInstructions` throws `NotFoundError` when the app holds no agent
under that name.

```ts
getDeveloperInstructions(appDetails, 'nope');
// throws NotFoundError: `nope` not found in the agentic system.
```

The lookup reads own keys only. `getDeveloperInstructions(appDetails,
'toString')` throws too, rather than resolving `Object.prototype.toString`.

The message matches adk-python byte for byte, backticks included, so a test that
pins it works against either runtime.
