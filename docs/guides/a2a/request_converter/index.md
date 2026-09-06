# Converting an A2A request into runner arguments

`convertA2aRequestToAgentRunRequest` maps an incoming A2A `RequestContext` onto
the arguments of `Runner.runAsync`. Reach for it when your application serves
A2A traffic itself, instead of through `toA2a` or `A2AAgentExecutor`.

## Introduction

An A2A server hands your executor a `RequestContext`. The ADK runner wants a
user id, a session id and a GenAI `Content`. Somebody has to map one onto the
other, and a hand-written mapping usually loses two things: the authenticated
caller, and the request-level metadata the client sent.

The converter does both. It reads the user name from the A2A call context when
the server authenticates the caller, and falls back to a name derived from the
A2A context id. It puts the request metadata on `customMetadata` under the key
`a2a_metadata`, so every event of the run carries it.

`toA2a` and `A2AAgentExecutor` already own this mapping for you. Use the
converter when you drive the runner directly, or when you want the same
behaviour under a different A2A server.

## Get started

```ts
import {convertA2aRequestToAgentRunRequest, Runner} from '@google/adk';
import {RequestContext} from '@a2a-js/sdk/server';

async function run(runner: Runner, requestContext: RequestContext) {
  const {userId, sessionId, newMessage, customMetadata} =
    convertA2aRequestToAgentRunRequest(requestContext);

  for await (const event of runner.runAsync({
    userId: userId ?? '',
    sessionId: sessionId ?? requestContext.contextId,
    newMessage: newMessage ?? {role: 'user', parts: []},
    customMetadata,
  })) {
    // Publish the event on your A2A event bus.
  }
}
```

Every field of `AgentRunRequest` is optional, while `runAsync` requires
`userId`, `sessionId` and `newMessage`. That is why the caller narrows them.

## What the default converter sets

| Field            | Value                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| `userId`         | `request.context.user.userName`, or `` `A2A_USER_${request.contextId}` `` |
| `sessionId`      | `request.contextId`                                                       |
| `newMessage`     | `{role: 'user', parts}`, the converted parts of the A2A message           |
| `customMetadata` | `{}`, or `{a2a_metadata: <request metadata>}`                             |

The role is always `user`, whatever role the A2A message carries. One A2A part
can produce zero, one or several GenAI parts, and the order of the parts
survives.

## Converting the parts yourself

The second parameter converts one A2A part. It defaults to `toGenAIPart`, and
your own `A2APartToGenAIPartConverter` may return one part, an array of parts,
or nothing for a part it does not handle:

```ts
import {
  A2APartToGenAIPartConverter,
  convertA2aRequestToAgentRunRequest,
} from '@google/adk';
import {RequestContext} from '@a2a-js/sdk/server';

const dropFiles: A2APartToGenAIPartConverter = (a2aPart) =>
  a2aPart.kind === 'text' ? {text: a2aPart.text} : undefined;

function convert(requestContext: RequestContext) {
  return convertA2aRequestToAgentRunRequest(requestContext, dropFiles);
}
```

## Failure modes

The converter throws `Error('Request message cannot be None')` when the request
carries no message. The A2A SDK types `userMessage` as always present, but a
real server can omit it.

Errors from the part converter propagate unchanged. The default `toGenAIPart`
throws on a part whose `kind` it does not recognise, so an unknown part kind
fails the whole request rather than being dropped.
