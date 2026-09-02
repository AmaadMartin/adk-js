# InMemoryArtifactService

`InMemoryArtifactService` keeps every artifact version in a plain object inside
the current process. Reach for it in tests, samples and local development, where
you want the artifact API without a bucket or a directory behind it.

## Introduction

An artifact is a named `Part` — a generated report, a chart, an uploaded PDF —
stored outside the conversation history so that the payload does not travel
through the model's context on every turn. Every save returns an integer
version, starting at 0.

Nothing this service stores survives a process restart, and two processes never
see each other's artifacts, so it is not a production store. Use
`FileArtifactService` for a local directory, or `GcsArtifactService` for Google
Cloud Storage. An agent's code does not change when you swap one for another,
only the service you hand to the `Runner`.

## Get started

```ts
import {InMemoryArtifactService} from '@google/adk';

const service = new InMemoryArtifactService();

const version = await service.saveArtifact({
  appName: 'app0',
  userId: 'user0',
  sessionId: 's0',
  filename: 'note.txt',
  artifact: {text: 'first draft'},
});
// version -> 0

const artifact = await service.loadArtifact({
  appName: 'app0',
  userId: 'user0',
  sessionId: 's0',
  filename: 'note.txt',
});
// artifact -> {text: 'first draft'}
```

## Listing filenames

A filename that starts with `user:` belongs to the user namespace, shared by
every session of that user. Any other filename belongs to the session you saved
it under.

`listArtifactKeys` returns a sorted list of filenames, with the `user:` prefix
preserved. Give it a `sessionId` to list that session plus the user namespace.
Omit the `sessionId` to list the user namespace alone. Every artifact service
follows this rule, not just the in-memory one.

```ts
await service.saveArtifact({
  appName: 'app0',
  userId: 'user0',
  sessionId: 's0',
  filename: 'user:profile.txt',
  artifact: {text: 'profile'},
});

await service.listArtifactKeys({
  appName: 'app0',
  userId: 'user0',
  sessionId: 's0',
}); // -> ['note.txt', 'user:profile.txt']

await service.listArtifactKeys({appName: 'app0', userId: 'user0'});
// -> ['user:profile.txt']
```

Omitting the `sessionId` is not the same as passing an empty string. An empty
string names a session whose id is empty, and lists that session's artifacts.

## Addressing a version

`loadArtifact` and `getArtifactVersion` take an optional `version`. Omit it for
the newest version. A positive version is an index from the start, and a
negative version counts from the end, so `-1` is the newest and `-2` the one
before it. A version outside the stored range resolves to `undefined` rather
than throwing.

```ts
await service.saveArtifact({
  appName: 'app0',
  userId: 'user0',
  sessionId: 's0',
  filename: 'note.txt',
  artifact: {text: 'second draft'},
});

await service.loadArtifact({
  appName: 'app0',
  userId: 'user0',
  sessionId: 's0',
  filename: 'note.txt',
  version: -2,
}); // -> {text: 'first draft'}
```

## Reading and seeding the store

The `artifacts` field is public, so a test can assert on what was stored, or
seed a version without a save. It maps a storage key to the stored versions,
oldest first. Each entry holds the saved `Part` as `data` and its metadata as
`artifactVersion`.

The key is `session/<app>/<user>/<session>/<filename>` for a session artifact
and `user/<app>/<user>/<filename>` for a user artifact. Every segment is encoded
with `encodeURIComponent`, so `user:profile.txt` appears as
`user%3Aprofile.txt`.

```ts
service.artifacts['user/app0/user0/user%3Aprofile.txt'] = [
  {data: {text: 'seeded'}, artifactVersion: {version: 0}},
];

await service.loadArtifact({
  appName: 'app0',
  userId: 'user0',
  sessionId: 's0',
  filename: 'user:profile.txt',
}); // -> {text: 'seeded'}
```

Entries are live, so a mutation is visible to every later read. The other
artifact services keep their storage private, because it lives in a bucket or on
disk rather than in the object.
