# FileArtifactService

`FileArtifactService` stores artifacts as ordinary files under a directory you
choose. Reach for it when one machine serves the agent and you want the payloads
on local disk, where you can inspect, back up and delete them with normal tools.

## Introduction

Every artifact service keeps a named payload out of the model's context and
returns an integer version instead. `InMemoryArtifactService` loses that payload
when the process exits, and `GcsArtifactService` needs a bucket and credentials.
`FileArtifactService` sits between them: the data survives a restart, and the
only dependency is a writable directory.

The trade is that a directory is not a distributed store. Two processes on the
same host can share a root safely, because a save reserves its version with an
exclusive `mkdir` and publishes with a single rename. Two processes on different
hosts sharing a network filesystem cannot, because neither operation is
guaranteed atomic there. Use `GcsArtifactService` for that.

## Get started

Construct the service with a directory path or a `file://` URI and hand it to
the `Runner`. Nothing else changes: a tool saves through the `Context` it
already receives.

```ts
import {FileArtifactService} from '@google/adk';

const artifactService = new FileArtifactService('/var/lib/my-agent/artifacts');

await artifactService.saveArtifact({
  appName: 'my-app',
  userId: 'alice',
  sessionId: 'session-1',
  filename: 'report.txt',
  artifact: {text: 'quarterly numbers'},
});

const loaded = await artifactService.loadArtifact({
  appName: 'my-app',
  userId: 'alice',
  sessionId: 'session-1',
  filename: 'report.txt',
});
// loaded.text === 'quarterly numbers'
```

## Storage layout

Each version is a directory holding the payload and a `metadata.json` document.
The payload keeps the last segment of the filename, so you can read it with
`cat` without consulting the metadata.

```
{root}/apps/{appName}/users/{userId}/
├── sessions/{sessionId}/artifacts/{filename}/versions/{version}/
│   ├── {filename basename}
│   └── metadata.json
└── artifacts/{filename}/versions/{version}/     # user: scoped artifacts
```

A filename may contain `/`. `report.txt` and `reports/q3.txt` are two separate
artifacts, and so are `doc` and `doc/nested` — deleting `doc` leaves
`doc/nested` in place.

Artifacts written by a release that predates the `apps/{appName}` level live
under `{root}/users/...` instead. That tree records no app name, and a root may
be shared by several apps, so this service never reads, writes or deletes it.
There is no migration: those artifacts are invisible.

## What a save guarantees

A save writes into `versions/.{version}.pending` and publishes it with one
`rename`. A reader therefore sees a version directory complete or not at all,
never a payload whose metadata is missing or half-written. If the save fails for
any reason — an unserializable `customMetadata`, a full disk, a killed process —
the staging directory is removed and no version appears.

One consequence is worth knowing: a staging directory left behind by a killed
process keeps its version number reserved forever. The next save skips it rather
than reclaiming it, so published version numbers are not guaranteed to be
contiguous. Treat the version as an opaque increasing handle.

## Rejected filenames

These raise `InputValidationError` rather than being sanitized:

- A rooted or drive-qualified name: `/etc/passwd`, `C:\report.txt`,
  `C:report.txt`, `\\server\share\x`.
- A name containing `..` under either separator, including one that would
  resolve back inside the scope, such as `folder/../alias.txt`.
- `metadata.json` in any casing, at any depth. The payload is stored under the
  artifact's own name, so that name would overwrite the metadata document.

`appName` and `userId` are validated as single path segments on every call, not
only on save. `sessionId` is validated whenever it contributes one, which is
every session-scoped call. A `user:` filename is stored outside the session, so
`sessionId` forms no part of its path and is not checked.

These checks operate on the supplied string. They stop a caller from naming a
path outside the root, but they are not a sandbox: they do not survive symlinks,
hardlinks, bind mounts, or a directory swapped between the check and the write.
Point the root at a directory the agent owns.
