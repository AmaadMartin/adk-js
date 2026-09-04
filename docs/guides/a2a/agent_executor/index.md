# A2AAgentExecutor converter configuration

`A2AAgentExecutor` translates one Agent2Agent (A2A) request into an ADK run,
and the run's ADK events back into A2A events. Four converter slots on its
config decide how that translation happens. Reach for them when the built-in
conversion is close but not what you want to publish.

## Introduction

Every executor holds a converter for each direction of the boundary:

- `a2aPartConverter` turns one inbound A2A part into a GenAI part.
- `genAiPartConverter` turns one outbound GenAI part into an A2A part.
- `adkEventConverter` turns one ADK event into the A2A events that represent
  it, and takes the artifact map of the execution in progress.
- `eventConverter` does the same, but takes the executor context instead of the
  artifact map.

An unset slot takes its declared default from
`A2A_AGENT_EXECUTOR_CONFIG_DEFAULTS`. The executor resolves the whole set once,
in its constructor, so a config it accepts cannot fail later in the middle of a
live stream.

The two event slots exist because adk-python declares two, one per executor
class. adk-js has one executor class, so it routes by which slot you set:
`eventConverter` runs when you supply it, and `adkEventConverter` runs
otherwise. `adkEventConverter` carries the built-in conversion, which is a
single artifact update per event.

The executor stamps ADK metadata — the app, user and session ids, the
invocation id, the author, the branch — onto every event a converter returns.
A converter does not have to reproduce it.

## Get started

```ts
import {A2AAgentExecutor, InMemorySessionService, LlmAgent} from '@google/adk';

const agent = new LlmAgent({
  name: 'greeter',
  model: 'gemini-2.0-flash',
  instruction: 'Greet the caller.',
});

const executor = new A2AAgentExecutor({
  runner: {
    agent,
    appName: agent.name,
    sessionService: new InMemorySessionService(),
  },
});
```

That executor uses every default. Pass a slot to replace one:

```ts
import {
  A2AAgentExecutor,
  toA2AArtifactUpdateEventsFromArtifactMap,
} from '@google/adk';

const executor = new A2AAgentExecutor({
  runner: myRunner,
  adkEventConverter: (
    adkEvent,
    agentsArtifacts,
    taskId,
    contextId,
    genAiPartConverter,
  ) => {
    if (adkEvent.author === 'internal_auditor') {
      return [];
    }
    return toA2AArtifactUpdateEventsFromArtifactMap(
      adkEvent,
      agentsArtifacts,
      taskId,
      contextId,
      genAiPartConverter,
    );
  },
});
```

Returning an empty array publishes nothing for that ADK event.

## The declared defaults

| Field                | Default                                    |
| -------------------- | ------------------------------------------ |
| `a2aPartConverter`   | `toGenAIPart`                              |
| `genAiPartConverter` | `toA2APart`                                |
| `eventConverter`     | unset                                      |
| `adkEventConverter`  | `toA2AArtifactUpdateEventsFromArtifactMap` |

`resolveA2aAgentExecutorConfig` applies that table, and you can call it
yourself to see what an executor would use:

```ts
import {resolveA2aAgentExecutorConfig} from '@google/adk';

const resolved = resolveA2aAgentExecutorConfig({});
// resolved.genAiPartConverter === A2A_AGENT_EXECUTOR_CONFIG_DEFAULTS.genAiPartConverter
```

## The artifact map

`adkEventConverter` receives a `Map` from an event author to the artifact id
that author is streaming into. The built-in converter reads it to give every
chunk of one response the same artifact id, and deletes the entry when the
final chunk arrives. A converter may mutate the map.

The executor creates one map per `execute` call, so two concurrent requests on
one executor never write into each other's artifact.

## Validation errors

A slot that is present and is not a function is rejected where the executor is
constructed:

```ts
// TypeScript rejects this literal at compile time. A value that reaches the
// config from JavaScript, or from a configuration document, is rejected here:
new A2AAgentExecutor({runner, genAiPartConverter: 'nope'});
// Error: A2A executor config field "genAiPartConverter" must be a function,
//        received string
```

`undefined` selects the default. `null` is a supplied value of the wrong type
and is rejected. The message names the field, and with several wrong fields it
names the first one in the order listed above.

`toA2AArtifactUpdateEventsFromArtifactMap` also rejects an undefined artifact
map, which matches `convert_event_to_a2a_events` in adk-python.
