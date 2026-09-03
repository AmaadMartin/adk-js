# VertexAiMemoryBankService

`VertexAiMemoryBankService` stores an agent's conversations in Vertex AI Memory
Bank and searches them later. Reach for it when you want a managed service to
extract, consolidate and rank memories, instead of holding them in your process.

## Introduction

Memory Bank offers two ways to turn events into memories.

`IngestEvents` appends events to a stream and generates memories when a trigger
rule fires: after a number of events, at a fixed interval, or once the stream
goes idle. `GenerateMemories` extracts memories from the events you send, right
away.

This service ingests by default, because a stream survives across sessions and
lets the service batch the extraction work. It switches to `GenerateMemories`
when your `customMetadata` carries a key that only that call accepts, such as
`allowedTopics` or `disableConsolidation`. A key both calls accept, or a key
neither recognises, keeps the ingest path; an unrecognised key becomes memory
metadata.

The ingest request is dispatched without being awaited. It takes about 800 ms to
trigger and returns nothing the caller acts on, so `addSessionToMemory` resolves
before the service replies. A failed request is logged, never thrown.

## Get started

```ts
import {VertexAiMemoryBankService} from '@google/adk';

const memoryService = new VertexAiMemoryBankService({
  projectId: 'my-project',
  location: 'us-central1',
  agentEngineId: '456',
});

// Ingests the session's events. Generation follows the trigger rule.
await memoryService.addSessionToMemory(session);

const response = await memoryService.searchMemory({
  appName: 'my-app',
  userId: 'user-1',
  query: 'favorite color',
});
```

`agentEngineId` is the last component of the agent engine resource name, so
`456` rather than `projects/my-project/locations/us-central1/reasoningEngines/456`.

## Control the stream and the trigger rule

`addEventsToMemory` accepts three ingest options through `customMetadata`.
`streamId` names the stream, `forceFlush` generates memories immediately, and
`generationTriggerConfig` sets the rule that flushes the buffer.

```ts
await memoryService.addEventsToMemory({
  appName: 'my-app',
  userId: 'user-1',
  events: session.events,
  customMetadata: {
    streamId: 'stream-123',
    generationTriggerConfig: {generationRule: {idleDuration: '60s'}},
  },
});
```

A request with no surviving event is still sent. It updates the trigger
configuration for the stream without flushing it.

## Route to GenerateMemories

Pass a key that only `GenerateMemories` accepts and the write goes there
instead, with no ingest request.

```ts
await memoryService.addEventsToMemory({
  appName: 'my-app',
  userId: 'user-1',
  events: session.events,
  customMetadata: {allowedTopics: ['USER_PREFERENCES']},
});
```

The generate-only keys are `allowedTopics`, `disableConsolidation`,
`disableMemoryRevisions`, `httpOptions`, `metadata`, `metadataMergeStrategy`,
`revisionExpireTime`, `revisionLabels`, `revisionTtl`, `ttl` and
`waitForCompletion`.

## Read structured profiles

A Memory Bank can hold a structured profile per registered schema, keyed by
scope. `retrieveProfiles` reads them. This is a lookup by scope, not a semantic
query, so it takes no search text.

```ts
const profiles = await memoryService.retrieveProfiles({
  appName: 'my-app',
  userId: 'user-1',
});

const userProfile = profiles.find((p) => p.schemaId === 'user-profile');
const name = userProfile?.profile?.['name'];
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

## Authenticate with your own credentials

The service uses Application Default Credentials. Pass `credentials` to
authenticate with something else, for example a credential obtained through
Workload Identity Federation outside Google Cloud.

```ts
const memoryService = new VertexAiMemoryBankService({
  projectId: 'my-project',
  location: 'us-central1',
  agentEngineId: '456',
  credentials: {keyFilename: '/path/to/key.json'},
});
```

The value is a `GoogleAuthOptions` from `google-auth-library`. An injected
`client` ignores it, because that client carries its own authentication.

## Failure modes

`searchMemory` never throws because of one bad entry. It warns and skips an
entry with no memory object or an empty fact, and if reading the results throws
part-way it logs the error and returns the entries it already read.

A malformed `customMetadata` value is warned about and dropped rather than
throwing. The exception is `enable_consolidation`, which must be a boolean and
raises a `TypeError` when it is not.

Vertex AI Express Mode is not supported: the Agent Engine client cannot send an
API key. The constructor throws when it resolves an Express Mode key without a
project and a location.
