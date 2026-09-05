# A2AAgentExecutor

`A2AAgentExecutor` serves an ADK agent over the Agent2Agent (A2A) protocol. It
runs the agent for one incoming A2A message and translates the ADK events the
run produces into A2A task, artifact and status events. Reach for it when
another agent, rather than a person, is the caller.

## Introduction

An A2A server hands each request to an `AgentExecutor` and reads back a stream
of events. `A2AAgentExecutor` is ADK's implementation of that interface. It
owns three things the protocol does not:

- **The session.** The executor maps the A2A `contextId` onto an ADK session,
  and the A2A caller onto the user id `A2A_USER_<contextId>`. One A2A context
  is therefore one continuing conversation. The session is loaded with its
  event history, which the pause check below reads.
- **The event translation.** Each ADK event with content becomes an A2A
  artifact update. The run then ends in exactly one terminal status event:
  `failed`, `input-required`, or `completed`.
- **The pause.** An ADK agent can stop and wait for a person, for example on a
  tool confirmation. The executor reports that as `input-required`, and it
  refuses to run again until the caller answers.

Most deployments never construct it directly. `toA2a()` builds one, wraps it in
an Express application and publishes the agent card. Construct the executor
yourself when you are embedding ADK in an A2A server you already run.

Related pieces: `RemoteA2AAgent` is the other end of the same wire, an ADK
agent that calls a remote A2A agent. `getA2AAgentCard()` builds the card that
describes the served agent.

## Get started

```typescript
import {bearerTokenUserBuilder, LlmAgent, toA2a} from '@google/adk';

const agent = new LlmAgent({
  name: 'weather_agent',
  model: 'gemini-2.5-flash',
  instruction: 'Answer questions about the weather.',
});

const app = await toA2a(agent, {
  port: 8000,
  authentication: bearerTokenUserBuilder(process.env.A2A_TOKEN!),
});
app.listen(8000);
```

To drive the executor from your own server, build it with a runner and call
`execute()` with the request context and the event bus the server gives you:

```typescript
import {A2AAgentExecutor, InMemorySessionService} from '@google/adk';

const executor = new A2AAgentExecutor({
  runner: {
    appName: 'weather_agent',
    agent,
    sessionService: new InMemorySessionService(),
  },
});
```

## What the runner option accepts

`runner` takes a `Runner`, a `RunnerConfig`, or a function returning either.
The function may be async, and it is called once per `execute()`.

A value that is none of those raises a `TypeError` naming what it received, so
a misconfigured deployment fails at the boundary rather than deep inside the
`Runner` constructor:

- When a factory returns the wrong thing:
  `Runner factory must return a Runner or a runner config, got <type>`.
- When the option itself is wrong:
  `Runner must be a Runner instance or a callable that returns a Runner, got <type>`.

## Event metadata

Every event the executor publishes carries the ADK session keys and a flag
identifying the executor generation:

```json
{
  "adk_app_name": "weather_agent",
  "adk_user_id": "A2A_USER_ctx-1",
  "adk_session_id": "ctx-1",
  "https://google.github.io/adk-docs/a2a/a2a-extension/": {
    "adk_agent_executor_v2": true
  }
}
```

Artifact updates carry more: the invocation id, the author, the branch, and any
citation, grounding or usage metadata the ADK event had. The invocation keys
are merged on top of those, never in place of them, so a client can read both.

The extension URL is `https://google.github.io/adk-docs/a2a/a2a-extension/`. A
Python peer publishes the same key with the same value.

## Failure modes

- **The agent reports an error.** An ADK event carrying `errorCode` or
  `errorMessage` makes the terminal event `failed`, whatever else the run
  produced. When several events carry an error, the last one wins. Artifact
  updates published before the error are still delivered.
- **The run throws.** The executor catches it and publishes a `failed` status
  whose message is `Agent run failed: <message>`.
- **A pending request is unanswered.** If the session or the incoming task
  still holds a request for user input that the new message does not answer,
  the executor publishes `input-required` and does not run the agent.
- **Cancellation.** `cancelTask()` is not implemented yet and throws.
