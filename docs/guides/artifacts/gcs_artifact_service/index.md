# GcsArtifactService

`GcsArtifactService` stores artifacts as objects in a Google Cloud Storage
bucket. Reach for it when more than one process or machine serves the same
agent, and when you need a link that a browser can open.

## Introduction

Every artifact service stores a named, versioned `Part` for one app, one user
and usually one session. `InMemoryArtifactService` loses everything when the
process exits, and `FileArtifactService` binds the artifacts to one disk. The
GCS service keeps them in a bucket, so any replica of your agent reads the same
artifact.

Two things follow from the storage being a bucket. A browser can open an object
directly, so this service adds `getAuthenticatedUrl` and `getSignedUrl`; the
other services have neither. And the identifiers that build the object name
come from a request path in the dev API server, so the service validates them
before it touches the bucket.

## Get started

Install the optional peer dependency `@google-cloud/storage`, then point the
service at a bucket. The credentials come from the ambient Google Cloud
environment, or from the `StorageOptions` you pass as the second argument.

```ts
import {GcsArtifactService} from '@google/adk';

const artifactService = new GcsArtifactService('my-bucket');

const version = await artifactService.saveArtifact({
  appName: 'my-app',
  userId: 'user1',
  sessionId: 'session1',
  filename: 'report.md',
  artifact: {text: '# Otters'},
});

const report = await artifactService.loadArtifact({
  appName: 'my-app',
  userId: 'user1',
  sessionId: 'session1',
  filename: 'report.md',
  version,
});
```

The object name is `{appName}/{userId}/{sessionId}/{filename}/{version}`. A
filename that starts with `user:` is stored under `{appName}/{userId}/user/`
instead, and every session of that user reads it.

## Linking to an artifact

`getAuthenticatedUrl` returns a `https://storage.cloud.google.com/...` link.
The reader must be signed in to a Google Account that has read permission on
the object.

```ts
const url = await artifactService.getAuthenticatedUrl({
  appName: 'my-app',
  userId: 'user1',
  sessionId: 'session1',
  filename: 'report.md',
});
```

`getSignedUrl` returns a link that carries its own authorization, so an
unauthenticated client can open it. Treat the link as a bearer token for the
object until it expires. It expires one hour from now and permits a read,
unless `signingOptions` says otherwise. Those options reach the storage client
unchanged, so anything its `GetSignedUrlConfig` accepts works here.

```ts
const signedUrl = await artifactService.getSignedUrl({
  appName: 'my-app',
  userId: 'user1',
  sessionId: 'session1',
  filename: 'report.md',
  signingOptions: {expires: Date.now() + 15 * 60 * 1000, version: 'v4'},
});
```

Signing needs credentials that can sign. The storage client reports a signing
failure, and the service does not catch it.

Both methods take an optional `version` and use the latest version without one.
Both return `undefined` when the artifact does not exist, and when the artifact
holds a pointer to a file the service does not own, such as
`gs://other-bucket/report.pdf`. There is no object of ours to link to in either
case.

## Artifact references

An artifact may point at another artifact instead of holding content. Save a
`Part` whose `fileData.fileUri` is an `artifact://` URI, and `loadArtifact`
returns the content of the artifact it names.

```ts
import {getArtifactUri} from '@google/adk';

await artifactService.saveArtifact({
  appName: 'my-app',
  userId: 'user1',
  sessionId: 'session1',
  filename: 'latest-report.md',
  artifact: {
    fileData: {
      fileUri: getArtifactUri({
        appName: 'my-app',
        userId: 'user1',
        sessionId: 'session1',
        filename: 'report.md',
        version: 0,
      }),
    },
  },
});
```

A model can populate a file URI, so a reference is untrusted input. The service
rejects a reference that names another app or another user with an
`InputValidationError`, on save and on load. It rejects a session-scoped
reference read from another session the same way. A reference without a session
is user-scoped, and any session of the same user may read it.

The service follows at most five references. A longer chain, and a cycle, raise
an `InputValidationError` that starts with `Exceeded maximum recursion depth
resolving artifact reference:`.

`getAuthenticatedUrl` and `getSignedUrl` follow references too, and return the
URL of the object the chain ends at.

## Identifier validation

`appName`, `userId` and `sessionId` become path segments of the object name, so
the service rejects a value that could move the object elsewhere. It throws an
`InputValidationError` for an empty value, a null byte, a leading slash or
backslash, a Windows drive letter such as `C:`, and a `..` traversal segment.

An interior slash is allowed, so a namespaced user id such as `group/user123`
works. A session-scoped artifact needs a session id: without one the service
throws `Session ID must be provided for session-scoped artifacts.`

## Version metadata

`getArtifactVersion` and `listArtifactVersions` report the object behind a
version.

```ts
const info = await artifactService.getArtifactVersion({
  appName: 'my-app',
  userId: 'user1',
  sessionId: 'session1',
  filename: 'report.md',
});
// info.canonicalUri === 'gs://my-bucket/my-app/user1/session1/report.md/0'
```

`canonicalUri` is the `gs://` URI of the object. `createTime` is the Unix
timestamp of the object, in seconds. `customMetadata` holds what you passed to
`saveArtifact`.

A filename may contain `/`, and GCS has a flat namespace, so `notes.txt` and
`notes.txt/attachments/report.pdf` are distinct artifacts that share a prefix.
`listVersions` counts only objects whose remaining name is a version number, so
the nested artifact does not appear in the versions of its parent.
