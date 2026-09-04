# FileArtifactService

`FileArtifactService` stores artifacts as files under a directory you choose.
Reach for it when one machine runs the agent and the artifacts must survive a
restart.

## Introduction

`InMemoryArtifactService` loses everything when the process exits, and
`GcsArtifactService` needs a bucket and credentials. `FileArtifactService` sits
between them. It keeps the same `BaseArtifactService` interface, so an agent
does not change when you swap one for another.

Every artifact belongs to one app, one user, and usually one session. The
service writes that scope into the directory path, so two apps that share a root
directory never see each other's artifacts. A filename may contain `/`. Each
segment becomes a directory, and `doc` and `doc/nested` stay two separate
artifacts.

Each save produces a new version, numbered from 0. A save is published with a
single directory rename, so a reader loads a complete version or none at all.

## Get started

Construct the service with a directory path, then pass it to the `Runner`. The
example below calls the service directly to show the round trip.

```ts
import {FileArtifactService} from '@google/adk';

const service = new FileArtifactService('/var/lib/my-agent/artifacts');
const scope = {appName: 'my-app', userId: 'u1', sessionId: 's1'};

const version = await service.saveArtifact({
  ...scope,
  filename: 'report.txt',
  artifact: {text: 'quarterly numbers'},
});
// version === 0

const loaded = await service.loadArtifact({...scope, filename: 'report.txt'});
// loaded.text === 'quarterly numbers'
```

The constructor also accepts a `file://` URI, which is what
`getArtifactServiceFromUri('file:///var/lib/my-agent/artifacts')` passes.

## Storage layout

```
root/
└── apps/{appName}/
    └── users/{userId}/
        ├── sessions/{sessionId}/artifacts/{artifactPath}/
        │   └── versions/
        │       ├── .{version}.pending/   # a save in progress
        │       └── {version}/
        │           ├── {artifactName}    # the payload
        │           └── metadata.json
        └── artifacts/{artifactPath}/...  # user-scoped, see below
```

A filename that starts with `user:` is stored under `users/{userId}/artifacts`
instead of under the session, so every session for that user reads the same
artifact. `listArtifactKeys` returns those keys with the `user:` prefix intact.

## Guarantees

A save stages the payload and the metadata document into
`versions/.{version}.pending`, then renames that directory to `versions/{version}`.
A reader never sees a half-written version, because the version list only counts
directories whose name is a number. If the save fails, the staging directory is
removed and no version is published.

A version number is reserved by creating its staging directory. Two concurrent
saves therefore get different numbers. A staging directory left behind by a
killed process keeps its number reserved forever: the next save steps over it
rather than reclaiming it, so published version numbers can have gaps.

`deleteArtifact` removes only the artifact's own `versions/` directory, then
removes the parent directories that this leaves empty. An artifact nested under
the deleted one survives.

`ArtifactVersion.canonicalUri` is always computed from the storage layout. The
service never reads a payload location out of `metadata.json`, because that
document sits inside the artifact tree and a caller can influence it.

## Filename rules

A filename is rejected with `InputValidationError` when it is rooted
(`/report.txt`, `\report.txt`, `//server/share/f.txt`), drive-qualified
(`C:\report.txt`, `C:report.txt`), or contains a `..` segment under either
separator. `folder/../alias.txt` is rejected even though it resolves back inside
the scope root, so one artifact cannot be addressed under two names.

An artifact may not be named `metadata.json` in any casing. Its payload is
stored under the artifact's own name and would overwrite the metadata document.
The check runs on the save path only, so an artifact stored under that name by
an older release stays readable and deletable.

`appName`, `userId` and `sessionId` must match `[a-zA-Z0-9_@-][a-zA-Z0-9_.@-]{0,255}`.

## Upgrading a root written before app scoping

Earlier releases wrote the same tree directly under `root/users`, which records
no app name. A root can be shared by several apps, so that tree cannot be
attributed to one of them. The service never reads it, writes to it, or deletes
it.

An existing root therefore looks empty after the upgrade, and version numbering
restarts at 0. The old files stay on disk untouched. Copy them under
`root/apps/{appName}/users/...` if you need them, or point the service at a new
root.
