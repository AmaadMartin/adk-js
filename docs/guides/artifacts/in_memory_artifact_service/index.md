# InMemoryArtifactService

`InMemoryArtifactService` keeps every artifact version in a plain object inside
the current process. Reach for it in tests, samples and local development, where
you want the artifact API without a bucket or a directory behind it.

## Introduction

An artifact is a named `Part` — a generated report, a chart, an uploaded PDF —
stored outside the conversation history so that the payload does not travel
through the model's context on every turn. Every save returns an integer
version, starting at 0.

`InMemoryArtifactService` implements that interface with a `Record` in memory.
Nothing survives a process restart, and two processes never see each other's
artifacts, so it is not a production store. Use `FileArtifactService` for a
local directory, or `GcsArtifactService` for Google Cloud Storage; an agent's
code does not change when you swap one for another, only the service you hand to
the `Runner`.

Two things separate it from the persistent implementations. The store is a
public field, so a test can read or seed it directly. And a save never fails on
I/O, so an artifact you just wrote is readable on the next line.

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

## Session scope and user scope

A filename that starts with `user:` is stored in the user namespace. It is
shared by every session of that user. Any other filename belongs to the session
you saved it under.

```ts
await service.saveArtifact({
  appName: 'app0',
  userId: 'user0',
  sessionId: 's0',
  filename: 'user:profile.txt',
  artifact: {text: 'profile'},
});
```

## Listing filenames

`listArtifactKeys` returns a sorted list of filenames, with the `user:` prefix
preserved. Give it a `sessionId` to list that session plus the user namespace.
Omit the `sessionId` to list the user namespace alone.

```ts
// Session artifacts plus user artifacts.
await service.listArtifactKeys({
  appName: 'app0',
  userId: 'user0',
  sessionId: 's0',
}); // -> ['note.txt', 'user:profile.txt']

// Only what the user owns, across all sessions.
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

The `artifacts` field is public. It maps a storage key to the list of stored
versions, oldest first. Each entry holds the saved `Part` as `data` and the
recorded metadata as `artifactVersion`.

The storage key is `session/<app>/<user>/<session>/<filename>` for a session
artifact and `user/<app>/<user>/<filename>` for a user artifact. Every segment
is encoded with `encodeURIComponent`, so `user:profile.txt` appears as
`user%3Aprofile.txt`.

Entries are live. A test can seed a version without a save, and the next read
serves it.

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

The field is public for parity with the Python implementation, where `artifacts`
is a pydantic field. The other artifact services keep their storage private,
because it lives in a bucket or on disk rather than in the object.
