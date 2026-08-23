# Typed A2A errors

`RemoteA2AAgent` raises `AgentCardResolutionError` when it cannot resolve an
agent card, and `A2AClientError` when an A2A client operation fails. Reach for
them when your application must treat a bad configuration differently from a
transport failure.

## Introduction

A remote agent fails for two very different reasons. The agent card can be
wrong: the path does not exist, the file is not valid JSON, or the URL does not
serve a card. That is an operator fault, and a retry produces the same failure.
The A2A client can also fail: no transport matches the card, or the remote agent
does not answer. That is a runtime condition, and a retry or a failover can
succeed.

Both used to arrive as a plain `Error`. A caller could only tell them apart by
matching the message text, which breaks whenever anyone edits a message. The two
error types make the distinction part of the API. `adk-python` declares the same
two types in `agents/remote_a2a_agent.py`, so the classification matches across
both SDKs.

Neither type changes any message. Both extend `Error`, so existing code that
reads `e.message` or checks `e instanceof Error` keeps working.

## Get started

```ts
import {
  isA2AClientError,
  isAgentCardResolutionError,
  RemoteA2AAgent,
} from '@google/adk';

const agent = new RemoteA2AAgent({
  name: 'remote',
  agentCard: '/etc/adk/agent-card.json',
});

try {
  for await (const event of runner.runAsync(request)) {
    handle(event);
  }
} catch (e: unknown) {
  if (isAgentCardResolutionError(e)) {
    // The card source is wrong. Fail the deployment; a retry will not help.
    throw new Error(`Check the agentCard setting: ${e.message}`, {cause: e});
  }
  if (isA2AClientError(e)) {
    // A transport or remote condition. Retry, or fail over to another peer.
    return failover(e);
  }
  throw e;
}
```

With a missing card file, the `catch` block sees:

```
AgentCardResolutionError: Failed to read agent card from file /etc/adk/agent-card.json: ENOENT: no such file or directory, open '/etc/adk/agent-card.json'
```

## Which failure raises which error

| Failure                                        | Error                      |
| ---------------------------------------------- | -------------------------- |
| Neither `agentCard` nor `client` is configured | `AgentCardResolutionError` |
| The card file is missing or unreadable         | `AgentCardResolutionError` |
| The card file is not valid JSON                | `AgentCardResolutionError` |
| The card cannot be fetched from its URL        | `AgentCardResolutionError` |
| No client can be built from the resolved card  | `A2AClientError`           |
| Sending a message to the remote agent fails    | `A2AClientError`           |

`adk-python` labels the client-construction failure `AgentCardResolutionError`,
because one catch-all in `_ensure_resolved` covers both steps. adk-js labels it
`A2AClientError`, because the card resolved successfully and the client did not.

Only the client call itself is typed. An error raised by your own
`afterRequestCallbacks`, or by event conversion, stays the error you threw.

## Which errors reach your code

The agent resolves its card and builds its client on the first run, before it
enters its own error handling. Those failures reject the `runAsync` generator,
so your `try` block catches them.

A failure during the exchange with the remote agent does not. The agent logs it
and emits a final `Event` that carries `errorMessage` and `turnComplete: true`.
Read `errorMessage` on the event to see it.

## Detecting the errors

Use `isAgentCardResolutionError` and `isA2AClientError`. Both match on the
error's `name`, so they stay correct when the error crosses a package boundary.
Two copies of adk-js in one runtime define two distinct classes, and an
`instanceof` check between them returns false.

## Reading the original failure

Each error attaches the failure it wrapped as `cause`, and keeps that failure's
message as its own.

```ts
if (isA2AClientError(e)) {
  logger.error(e.message, e.cause);
}
```
