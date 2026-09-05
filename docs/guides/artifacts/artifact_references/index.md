# Artifact references

An artifact reference is a `Part` that names another artifact instead of
carrying a copy of it. `InMemoryArtifactService` resolves the reference when you
load it, so a caller reads the target's content and never sees the pointer.
Reach for it when several artifacts share one payload.

## Introduction

An agent that saves the same 200 KB report under three filenames stores it three
times. The alternative is to save the payload once and store a pointer to it
everywhere else. A pointer is only useful if the service follows it, and only
safe if the service checks who is allowed to follow it.

A reference is a `fileData` part whose `fileUri` uses the `artifact://` scheme:

```
artifact://apps/{appName}/users/{userId}/sessions/{sessionId}/artifacts/{filename}/versions/{version}
artifact://apps/{appName}/users/{userId}/artifacts/{filename}/versions/{version}
```

The second form is user-scoped and carries no session. A model can populate a
`fileUri`, so the URI is untrusted input: the service validates it when you save
the reference, and validates it again when you load it.

## Get started

Save the target, then save a part that points at it. Loading the reference
returns the target's content.

```ts
import {InMemoryArtifactService} from '@google/adk';

const service = new InMemoryArtifactService();
const key = {appName: 'app0', userId: 'user0', sessionId: '123'};

await service.saveArtifact({
  ...key,
  filename: 'source.txt',
  artifact: {text: 'hello'},
});

await service.saveArtifact({
  ...key,
  filename: 'ref.txt',
  artifact: {
    fileData: {
      fileUri:
        'artifact://apps/app0/users/user0/sessions/123/artifacts/source.txt/versions/0',
      mimeType: 'text/plain',
    },
  },
});

const loaded = await service.loadArtifact({...key, filename: 'ref.txt'});
// loaded is {text: 'hello'}
```

A reference stores no MIME type of its own, because the real type is unknown
until the reference resolves. `getArtifactVersion` reports `undefined` for it.

## Scope containment

The service rejects a reference that leaves the caller's scope. It throws
`InputValidationError` on save and on load:

| Reference                       | Caller                 | Result                                                                        |
| ------------------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| Session-scoped, same session    | Any                    | Allowed                                                                       |
| User-scoped                     | Same user, any session | Allowed                                                                       |
| Another app or another user     | Any                    | `Artifact references must stay within the same app and user scope.`           |
| Session-scoped, another session | Any                    | `Session-scoped artifact references must stay within the same session scope.` |
| Not a valid `artifact://` URI   | Any                    | `Invalid artifact reference URI: …`                                           |

The load-side check matters on its own. It catches a stored URI that changed
after it was saved.

A reference may point at another reference. The service follows at most ten
links, then throws `InputValidationError`, so a cycle cannot exhaust the stack.

## Version identity

Every saved version records a `canonicalUri` that names where the in-memory
service keeps it:

```ts
const version = await service.getArtifactVersion({
  ...key,
  filename: 'source.txt',
});
// version.canonicalUri is
// 'memory://apps/app0/users/user0/sessions/123/artifacts/source.txt/versions/0'
```

A `user:` filename is owned by the user rather than the session, so its
canonical URI omits the `sessions` segment.

## Identifier validation

`appName`, `userId` and `sessionId` build the storage key, so the service
rejects a value that could change it. An empty value, a null byte, a leading
slash, a Windows drive prefix such as `C:`, and a `..` segment each throw
`InputValidationError`. A `/` inside a value is allowed: `group/user123` is a
valid user ID.

A `user:` filename needs no session. Every other filename does, and a save
without one throws `Session ID must be provided for session-scoped artifacts.`

## Untyped artifact input

`SaveArtifactRequest.artifact` accepts a plain object as well as a `Part`, so an
HTTP body may name the fields the way the wire format does. Every artifact
service converts `inline_data` to `inlineData` before it reads a field, and
stores a copy, so a later write to your object cannot reach stored state.

```ts
await service.saveArtifact({
  ...key,
  filename: 'note.txt',
  artifact: {inline_data: {mime_type: 'text/plain', data: 'aGVsbG8='}},
});
```

## Empty artifacts

`loadArtifact` returns `undefined` for a stored artifact that carries no
content — an empty part, an empty string, or inline data with no bytes. A caller
therefore treats "missing" and "empty" the same way.

## Limitations

- Only `InMemoryArtifactService` resolves references today.
  `FileArtifactService` and `GcsArtifactService` still return the pointer.
- The service resolves a reference on `loadArtifact` only. `listArtifactKeys`,
  `listVersions` and `getArtifactVersion` report the reference itself.
