# Artifact version metadata

`ArtifactVersion` is the record an artifact service keeps about one saved
version: where it lives, when it was written, its media type, and whatever the
caller attached to it. Read it when you need to describe an artifact without
loading its bytes.

## Introduction

`saveArtifact` returns only a version number, and `loadArtifact` returns the
whole payload. Listing ten artifacts in a UI needs neither: it needs a name, a
size-free description, and a time. That is what `getArtifactVersion` and
`listArtifactVersions` give you.

Every field except `mimeType` is always present, on every service:

| Field            | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `version`        | The version number. The first save is `0`.                  |
| `canonicalUri`   | Where the service holds this version.                       |
| `customMetadata` | What the caller attached, or `{}`.                          |
| `createTime`     | When the service recorded the version, in Unix **seconds**. |
| `mimeType`       | The media type, when the service knows one.                 |

Two of those are worth reading twice. `createTime` is in seconds, not
milliseconds, because `adk-python` reports seconds and a record may cross
between the two SDKs; divide by nothing and multiply by 1000 before you hand it
to `new Date()`. And `customMetadata` is an object even when the caller supplied
none, so you can read a key from it without a guard.

`canonicalUri` names the version in the scheme of the service that stored it:

| Service                   | Scheme                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `InMemoryArtifactService` | `memory://apps/{app}/users/{user}/sessions/{session}/artifacts/{filename}/versions/{version}` |
| `FileArtifactService`     | `file://` URL of the payload on disk                                                          |
| `GcsArtifactService`      | the public URL of the blob                                                                    |

A `user:`-prefixed filename is scoped to the user rather than the session, so
the in-memory URI for it carries no session segment.

## Get started

Save an artifact, then read its version record.

```ts
import {InMemoryArtifactService} from '@google/adk';

const service = new InMemoryArtifactService();
const key = {appName: 'app0', userId: 'user0', sessionId: '123'};

const version = await service.saveArtifact({
  ...key,
  filename: 'report.md',
  artifact: {text: '# Report'},
  customMetadata: {topic: 'sales'},
});

const record = await service.getArtifactVersion({
  ...key,
  filename: 'report.md',
  version,
});

record?.canonicalUri;
// memory://apps/app0/users/user0/sessions/123/artifacts/report.md/versions/0
record?.customMetadata; // {topic: 'sales'}
new Date(record!.createTime * 1000); // the moment of the save
```

`listArtifactVersions` returns the same record for every version of one
filename, oldest first.

## Writing a version record

A service builds its records with `createArtifactVersion`, which supplies the
two defaults:

```ts
import {createArtifactVersion} from '@google/adk';

const record = createArtifactVersion({
  version: 0,
  canonicalUri:
    'memory://apps/app0/users/user0/artifacts/user:notes.md/versions/0',
});

record.customMetadata; // {}
record.createTime; // Unix seconds, stamped now
```

Use it if you implement `BaseArtifactService` yourself. Passing an explicit
`customMetadata` or `createTime` overrides the default; both are then stored
verbatim.

## What is not recorded

The record describes the version, not the payload. It carries no byte count and
no checksum, and `mimeType` is absent when the service could not determine one —
`FileArtifactService`, for instance, stores a text artifact without a media
type.
