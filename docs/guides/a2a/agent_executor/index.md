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
  it, and takes the artifact map of the execution in progress. It is the
  counterpart of `adk_event_converter` on adk-python's
  `A2aAgentExecutorConfig`.
- `eventConverter` does the same job, but takes the `ExecutorContext` instead
  of the artifact map. It is the counterpart of `event_converter` on that same
  config. Use it when the conversion depends on the session, the user or the
  request rather than on the stream in progress.

A defaulted slot that you leave unset takes the default named below. The
executor resolves the whole set once, in its constructor, so a config it
accepts cannot fail later in the middle of a live stream.

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
| `eventConverter`     | none                                       |
| `adkEventConverter`  | `toA2AArtifactUpdateEventsFromArtifactMap` |

`resolveA2aAgentExecutorConfig` applies those defaults. The executor calls it
in its constructor.

## Converting an event from the executor context

`eventConverter` is the second ADK-event slot. It receives the
`ExecutorContext` of the run, which carries the session, the user, the events
so far and the `RequestContext` the A2A server built:

```ts
import {A2AAgentExecutor} from '@google/adk';

const executor = new A2AAgentExecutor({
  runner: myRunner,
  eventConverter: (adkEvent, ctx, genAiPartConverter) => [
    {
      kind: 'status-update',
      taskId: ctx.requestContext.taskId,
      contextId: ctx.requestContext.contextId,
      final: false,
      status: {
        state: 'working',
        message: {
          kind: 'message',
          messageId: adkEvent.id,
          role: 'agent',
          parts: (adkEvent.content?.parts ?? []).map((part) =>
            genAiPartConverter(part),
          ),
        },
      },
    },
  ],
});
```

It has no default, and the executor prefers it over `adkEventConverter` when
you set both. adk-python splits these two slots across two executor classes;
adk-js has one executor, so the precedence rule stands in for that split.

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
// config from untyped JavaScript is rejected here instead:
new A2AAgentExecutor({runner, genAiPartConverter: 'nope'});
// Error: A2A executor config field "genAiPartConverter" must be a function,
//        received string
```

`undefined` selects the default. `null` is a supplied value of the wrong type
and is rejected. The message names the field, and with several wrong fields it
names the first one in the order listed above.
