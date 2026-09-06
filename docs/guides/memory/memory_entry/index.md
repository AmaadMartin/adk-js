# MemoryEntry

`MemoryEntry` is the shape every memory service reads and returns. Reach for
`createMemoryEntry` when you build one by hand, so it carries the same defaults
a service-produced entry carries.

## Introduction

A memory service stores content and hands it back later. `MemoryEntry` is the
value that crosses that boundary: `content` is required, and `author`,
`timestamp`, `id` and `customMetadata` describe it.

Two of those fields are for the caller, not the service. `id` names the memory,
so you choose its identifier instead of letting the service generate one.
`customMetadata` carries your own keys next to the memory; a service that
supports metadata stores them and returns them on retrieval.

`MemoryEntry` is a TypeScript interface, so it holds no runtime defaults on its
own. `createMemoryEntry` supplies them. Its only default today is
`customMetadata: {}`, which means code reading `entry.customMetadata` never has
to guard against `undefined`. An object literal typed as `MemoryEntry` is still
valid, and both new fields are optional, so existing code keeps working.

Support is per service. `VertexAiMemoryBankService` reads both fields.
`InMemoryMemoryService` reads neither, and stores entries as it always has.

## Get started

```ts
import {createMemoryEntry} from '@google/adk';

const entry = createMemoryEntry({
  id: 'mem-123',
  content: {role: 'user', parts: [{text: 'user prefers metric units'}]},
  customMetadata: {source: 'onboarding-form'},
});

const bare = createMemoryEntry({
  content: {role: 'user', parts: [{text: 'user likes blue'}]},
});
bare.customMetadata; // {}
```

## Vertex AI Memory Bank

`VertexAiMemoryBankService.addMemory` forwards `entry.id` as the `memoryId` of
the created memory. An entry with no `id` sends no `memoryId`, and the service
generates one.

```ts
import {createMemoryEntry, VertexAiMemoryBankService} from '@google/adk';

const service = new VertexAiMemoryBankService({agentEngineId});

await service.addMemory({
  appName: 'my-app',
  userId: 'user-1',
  memories: [
    createMemoryEntry({
      id: 'mem-123',
      content: {role: 'user', parts: [{text: 'user prefers metric units'}]},
      customMetadata: {source: 'onboarding-form'},
    }),
  ],
});
```

Two precedence rules apply when the same key arrives twice:

- A `memoryId` key inside `customMetadata` wins over `entry.id`.
- Keys in `entry.customMetadata` win over the call-level `customMetadata`
  passed to `addMemory`.

`searchMemory` converts the metadata stored with each retrieved memory back
into `customMetadata`, unwrapping the Vertex value types (boolean, double,
string and timestamp) into plain values. A memory with no stored metadata
yields `{}`.

## Parity with adk-python

The fields match `MemoryEntry` in adk-python
(`src/google/adk/memory/memory_entry.py`). `customMetadata` is that model's
`custom_metadata`, whose `default_factory=dict` this guide's `{}` default
mirrors. The Vertex behaviour above matches
`src/google/adk/memory/vertex_ai_memory_bank_service.py`.
