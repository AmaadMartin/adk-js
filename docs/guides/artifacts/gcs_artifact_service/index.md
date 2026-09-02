# GcsArtifactService URLs and references

`GcsArtifactService` keeps each artifact version as an object in a Cloud
Storage bucket. On top of save and load it hands out a URL for an artifact, and
it follows an `artifact://` pointer from one artifact to another. Reach for the
URLs when a browser should fetch the bytes instead of the agent server, and for
the pointers when two artifacts hold the same payload.

## Introduction

Serving an artifact through the agent means the bytes cross the process twice:
once out of the bucket, once out to the caller. A 200 MB report ties up a
request for as long as it takes to stream. Cloud Storage can serve the object
itself, so the service exposes two ways to address it.

A **signed URL** carries its own authorization. Anyone holding the URL may read
the object until it expires, so it suits an `<img src>` or a download link for a
reader who has no Google account. An **authenticated URL** carries none. It
points at the Cloud console, and the object's IAM policy decides who may read
it, so it suits a link between colleagues.

An **artifact reference** is the third piece. A tool that wants a second name
for an existing 200 MB blob can store a small `artifact://` pointer instead of a
copy. Loading the pointer returns the target, so a caller does not need to know
which of the two it holds. A reference may not leave the app, the user, or —
for a session-scoped target — the session that stored it, and the chain of
pointers is bounded, so a self-referential artifact is rejected rather than
followed forever.

## Get started

Save an artifact, then ask for a URL for it. Nothing else has to be wired up:
the service reads the bytes it stored a moment earlier.

```ts
import {GcsArtifactService} from '@google/adk';

const service = new GcsArtifactService('my-bucket');
const key = {appName: 'chart-app', userId: 'u1', sessionId: 's1'};

const version = await service.saveArtifact({
  ...key,
  filename: 'chart.png',
  artifact: {inlineData: {data: pngBase64, mimeType: 'image/png'}},
});

// A read URL that stops working in fifteen minutes.
const signed = await service.getSignedUrl({
  ...key,
  filename: 'chart.png',
  version,
  signingOptions: {expires: Date.now() + 15 * 60 * 1000},
});

// A console link, gated by the object's IAM policy.
const authenticated = await service.getAuthenticatedUrl({
  ...key,
  filename: 'chart.png',
  version,
});
```

Both methods take the latest version when the request names none. Both return
`undefined` when the artifact does not exist.

## Signing options

`signingOptions` is the storage client's own `GetSignedUrlConfig`, so every knob
the client accepts is available. The service supplies two defaults and your
options override them: the action is `'read'`, and the URL expires one hour
after the call.

```ts
const url = await service.getSignedUrl({
  ...key,
  filename: 'chart.png',
  signingOptions: {version: 'v4', expires: Date.now() + 60 * 1000},
});
```

Signing happens locally, from the credentials the client already holds. The
service reads the object's metadata to decide whether the artifact exists, and
makes no other request.

## Storing a reference

A reference is a `Part` whose `fileData.fileUri` uses the `artifact://` scheme.
Two shapes exist, one per scope:

```
artifact://apps/{app}/users/{user}/sessions/{session}/artifacts/{filename}/versions/{version}
artifact://apps/{app}/users/{user}/artifacts/{filename}/versions/{version}
```

The second form names a user-scoped artifact, so any session of that user may
read it.

```ts
await service.saveArtifact({
  ...key,
  filename: 'latest-chart.png',
  artifact: {
    fileData: {
      fileUri:
        'artifact://apps/chart-app/users/u1/sessions/s1/artifacts/chart.png/versions/0',
      mimeType: 'image/png',
    },
  },
});

// Returns the bytes of chart.png, not the pointer.
const chart = await service.loadArtifact({
  ...key,
  filename: 'latest-chart.png',
});
```

`getSignedUrl` and `getAuthenticatedUrl` follow the same chain, so both return a
URL for the target object.

A `fileData` URI that uses any other scheme is a pointer to a file this service
does not own. `loadArtifact` returns it unchanged, and both URL methods return
`undefined` for it.

## What the service rejects

Every failure below throws `InputValidationError`.

| Condition                                                                                                     | When                      |
| ------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `appName`, `userId` or `sessionId` holds a traversal segment, a null byte, a leading slash, or a drive letter | every operation           |
| a session-scoped artifact is addressed with no session                                                        | every operation           |
| an `artifact://` URI does not match the grammar                                                               | save and load             |
| a reference names another app or user                                                                         | save and load             |
| a session-scoped reference names another session                                                              | save and load             |
| a chain of references is longer than five hops                                                                | load and both URL methods |

The scope checks run on load as well as on save, so rewriting a stored URI in
the bucket does not grant a read across the scope it was stored in.

## Version metadata

`getArtifactVersion` and `listArtifactVersions` report two fields about the
stored object. `canonicalUri` is `gs://{bucket}/{object}`. `createTime` is the
object's creation time as a Unix timestamp in seconds, or `undefined` when the
object reports none. Neither method follows references: both describe the
object that holds the version you asked for.

## Object layout

A session-scoped artifact lives at `{app}/{user}/{session}/{filename}/{version}`.
A filename that starts with `user:` is user-scoped, and the prefix is stripped
from the object name: `user:profile.png` is stored at
`{app}/{user}/user/profile.png/{version}`. An authenticated URL addresses that
object, so it reads `.../user/profile.png/0`.
