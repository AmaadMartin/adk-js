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

Every field of `AgentRunRequest` is optional, so a custom converter can fill
only the slots it needs. `runAsync` requires `userId`, `sessionId` and
`newMessage`, which is why the caller narrows them.

## What the default converter sets

| Field            | Value                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| `userId`         | `request.context.user.userName`, or `` `A2A_USER_${request.contextId}` `` |
| `sessionId`      | `request.contextId`                                                       |
| `newMessage`     | `{role: 'user', parts}`, the converted parts of the A2A message           |
| `customMetadata` | `{}`, or `{a2a_metadata: <request metadata>}`                             |

The role is always `user`, whatever role the A2A message carries. One A2A part
can produce zero, one or several GenAI parts, and the order of the parts
survives. `invocationId`, `stateDelta` and `runConfig` stay empty; they exist
for a custom converter to fill.

## Supplying your own converter

`A2ARequestToAgentRunRequestConverter` is the substitution seam. An
implementation takes the request and a part converter, and returns the same
`AgentRunRequest` shape:

```ts
import {
  A2APartToGenAIPartConverter,
  A2ARequestToAgentRunRequestConverter,
  AgentRunRequest,
  convertA2aRequestToAgentRunRequest,
} from '@google/adk';
import {RequestContext} from '@a2a-js/sdk/server';

const tenantScoped: A2ARequestToAgentRunRequestConverter = (
  request: RequestContext,
  partConverter: A2APartToGenAIPartConverter,
): AgentRunRequest => {
  const runRequest = convertA2aRequestToAgentRunRequest(request, partConverter);
  return {...runRequest, userId: `acme:${runRequest.userId}`};
};
```

The second parameter converts one A2A part. It defaults to `toGenAIPart`, and a
custom implementation may return one part, an array of parts, or nothing for a
part it does not handle.

## Failure modes

The converter throws `Error('Request message cannot be None')` when the request
carries no message. The A2A SDK types `userMessage` as always present, but a
real server can omit it.

Errors from the part converter propagate unchanged. The default `toGenAIPart`
throws on a part whose `kind` it does not recognise, so an unknown part kind
fails the whole request rather than being dropped.
