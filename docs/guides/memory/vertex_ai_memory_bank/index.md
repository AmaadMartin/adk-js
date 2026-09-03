# VertexAiMemoryBankService

`VertexAiMemoryBankService` stores an agent's conversations in Vertex AI Memory
Bank and searches them later. Reach for it when memory must outlive the process
and be shared by every replica of a deployed agent.

## Introduction

The service implements `BaseMemoryService`, so the `load_memory` tool and the
memory helpers on `Context` work with it unchanged. Memory Bank adds two things
an in-process service cannot give you: the server extracts durable facts from
raw events, and it keeps them under a scope of `{app_name, user_id}`.

There are two write paths, and the metadata you pass picks between them.
`memories.ingestEvents` is the default. It appends the events to a stream and
generates memories when a trigger rule fires: after a number of events, at a
fixed interval, or once the stream goes idle. A write therefore costs one
dispatch and the caller does not wait for extraction. `memories.generate` is the
other path: it extracts immediately and accepts options such as `ttl`,
`allowedTopics` and `metadata`. Use generate when you need one of those options;
otherwise ingest is cheaper.

Reading has two shapes as well. `searchMemory` is a semantic query and returns
the facts nearest to it. `retrieveProfiles` is a scope-keyed lookup and returns
the structured profiles registered for the agent engine, one per schema.

## Get started

The agent engine id is the last component of the agent engine resource name, so
`456` rather than
`projects/my-project/locations/us-central1/reasoningEngines/456`. The service
authenticates with Application Default Credentials; an Express Mode API key is
rejected, because the Agent Engine client cannot send one.

```ts
import {VertexAiMemoryBankService} from '@google/adk';

const memoryService = new VertexAiMemoryBankService({
  projectId: 'my-project',
  location: 'us-central1',
  agentEngineId: '456',
});

// Write: dispatches memories.ingestEvents and returns without waiting.
await memoryService.addSessionToMemory(session);

// Read: a semantic query over the scope.
const {memories} = await memoryService.searchMemory({
  appName: 'my-app',
  userId: 'user-1',
  query: 'favourite colour',
});
```

## Choosing the write path

`addEventsToMemory` takes the events directly and reads `customMetadata`. A key
that `memories.generate` understands and `ingestEvents` does not routes the
write to generate. Every other key leaves it on the default ingest path, and a
key that neither call recognises becomes memory metadata.

| Key                                                    | Path     | Effect                                                 |
| ------------------------------------------------------ | -------- | ------------------------------------------------------ |
| `streamId`                                             | ingest   | The stream the events join.                            |
| `forceFlush`                                           | ingest   | Flushes the buffer at once, ignoring the trigger rule. |
| `generationTriggerConfig`                              | ingest   | Sets when the server generates memories.               |
| `allowedTopics`, `ttl`, `revisionTtl`, `metadata`, ... | generate | Passed as the generate config.                         |

The generate-only keys are `allowedTopics`, `disableConsolidation`,
`disableMemoryRevisions`, `httpOptions`, `metadata`, `metadataMergeStrategy`,
`revisionExpireTime`, `revisionLabels`, `revisionTtl`, `ttl` and
`waitForCompletion`.

```ts
// Ingest path: batched server-side by the trigger rule.
await memoryService.addEventsToMemory({
  appName: 'my-app',
  userId: 'user-1',
  events: session.events,
  customMetadata: {
    streamId: 'stream-123',
    generationTriggerConfig: {generationRule: {idleDuration: '60s'}},
  },
});

// Generate path: allowedTopics is a generate-only option.
await memoryService.addEventsToMemory({
  appName: 'my-app',
  userId: 'user-1',
  events: session.events,
  customMetadata: {allowedTopics: ['USER_PREFERENCES']},
});
```

An event whose content holds no text, inline data, file data, function call,
function response, executable code, code execution result, tool call or tool
response is dropped before the request. A request with no event left is still
sent on the ingest path, because it updates the trigger rule without flushing
the stream.

## Structured profiles

A profile is the structured counterpart of a fact: the agent engine fills one
per registered schema from the same scope. `retrieveProfiles` returns them all.
It is a lookup by scope, not a semantic query, so it takes no search text.

```ts
const profiles = await memoryService.retrieveProfiles({
  appName: 'my-app',
  userId: 'user-1',
});

const preferences = profiles.find(
  (profile) => profile.schemaId === 'user-preferences',
)?.profile;
```

The method is specific to this service. It is not part of `BaseMemoryService`,
so you need a `VertexAiMemoryBankService` reference to call it.

## Write and read custom metadata

`addMemory` stores explicit facts. A `MemoryEntry.id` becomes the last component
of the created memory's resource name, and `customMetadata` is stored with the
memory.

```ts
await memoryService.addMemory({
  appName: 'my-app',
  userId: 'user-1',
  memories: [
    {
      id: 'user-color',
      content: {parts: [{text: 'The user likes green.'}]},
      customMetadata: {source: 'onboarding'},
    },
  ],
});
```

An explicit `customMetadata.memoryId` wins over `MemoryEntry.id`.

`searchMemory` returns the stored metadata as plain values on each entry's
`customMetadata`, so the `{stringValue: 'onboarding'}` that Memory Bank holds
comes back as `'onboarding'`.

## Failure modes

The ingest request is dispatched without being awaited, so it cannot reject the
caller. A failed request is logged at `error` and the events are lost; use the
generate path when a write must be confirmed.

`searchMemory` tolerates a malformed response. It skips a result with no memory
and a result with no fact, and logs each skip at `warn`, so one bad result does
not cost you the others.

The service warns about a malformed `customMetadata` value and drops it instead
of throwing. The exception is `enable_consolidation`, which must be a boolean
and raises a `TypeError` when it is not.
