# Typed A2A errors

`RemoteA2AAgent` raises `AgentCardResolutionError` when it cannot resolve an
agent card, and `A2AClientError` when it cannot build a client from that card.
Reach for them when your application must treat a bad configuration differently
from a transport failure.

## Introduction

Both failures used to arrive as a plain `Error`, so telling them apart meant
matching the message text. That breaks whenever anyone edits a message. The two
types make the distinction part of the API, and `adk-python` declares the same
two in `agents/remote_a2a_agent.py`.

The distinction is worth acting on. A card fault is an operator fault, so a
retry produces the same failure. A client fault can be a transport condition, so
a retry or a failover can succeed.

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

Use the two guards rather than `instanceof`. They match on the error's `name`,
so they stay correct when two copies of adk-js share one runtime. Each error
keeps the message of the failure it wrapped, and attaches that failure as
`cause`.

## Which failure raises which error

| Failure                                        | Error                      |
| ---------------------------------------------- | -------------------------- |
| Neither `agentCard` nor `client` is configured | `AgentCardResolutionError` |
| The card file is missing or unreadable         | `AgentCardResolutionError` |
| The card file is not valid JSON                | `AgentCardResolutionError` |
| The card cannot be fetched from its URL        | `AgentCardResolutionError` |
| No client can be built from the resolved card  | `A2AClientError`           |

`adk-python` labels the client-construction failure `AgentCardResolutionError`,
because one catch-all in `_ensure_resolved` covers both steps. adk-js labels it
`A2AClientError`, because the card resolved successfully and the client did not.

## Which errors reach your code

The agent resolves its card and builds its client on the first run, before it
enters its own error handling. Those failures reject the `runAsync` generator,
so the `try` block above catches them. Both typed errors come from that step.

A later failure does not reject. If the exchange with the remote agent fails,
the agent logs the error and emits a final `Event` carrying `errorMessage` and
`turnComplete: true`. Read `errorMessage` on the event to see it. That value is
the message of the original failure, whatever its type.
