# Saving artifacts over the dev API server

`POST /apps/{appName}/users/{userId}/sessions/{sessionId}/artifacts` stores one
artifact in the artifact service the dev API server runs with. Reach for it when
a client outside the server process must seed an artifact, for example a test
harness or a script that prepares a session before an agent runs.

The sibling artifact routes only read: they list the filenames in a session,
load a version, and delete an artifact. Without this route, the only way to
create an artifact is from inside the server process, through the `Context` an
agent tool receives. Storage stays append-only, so a second save of the same
filename creates version 1 and leaves version 0 in place.

## Get started

From TypeScript, use `AdkApiClient.saveArtifact`. It returns the
`ArtifactVersion` the server reports, and throws the server's `error` message
when the request fails.

```ts
import {AdkApiClient} from '@google/adk-devtools';

const client = new AdkApiClient({backendUrl: 'http://localhost:8000'});

const saved = await client.saveArtifact({
  appName: 'get_started',
  userId: 'u',
  sessionId: 's',
  filename: 'greeting.txt',
  artifact: {text: 'hello world'},
  customMetadata: {rev: 'one'},
});
// saved.version === 0

await client.loadArtifact({
  appName: 'get_started',
  userId: 'u',
  sessionId: 's',
  artifactName: 'greeting.txt',
});
// {text: 'hello world'}
```

From any other language, post the same body yourself:

```bash
curl -X POST \
  http://localhost:8000/apps/get_started/users/u/sessions/s/artifacts \
  -H 'Content-Type: application/json' \
  -d '{"filename":"greeting.txt","artifact":{"text":"hello world"}}'
```

The session must exist first. Create it with
`POST /apps/{appName}/users/{userId}/sessions/{sessionId}`.

## Request body

| Field            | Type     | Required | Notes                                                                                                      |
| ---------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `filename`       | `string` | yes      | Non-empty. The artifact key inside the session.                                                            |
| `artifact`       | `Part`   | yes      | A `@google/genai` `Part`, for example `{"text": "..."}`, `{"inlineData": {...}}` or `{"fileData": {...}}`. |
| `customMetadata` | `object` | no       | Stored with the version and returned unchanged.                                                            |

## Response

The body is the `ArtifactVersion` the artifact service reports for the saved
version. It always carries `version`. `InMemoryArtifactService` adds
`customMetadata` when you supplied it, and `mimeType` for a `fileData` artifact.

```
{"version":0,"customMetadata":{"rev":"one"}}
```

## Errors

- `400` — the body has no `filename` or no `artifact`. The server does not call
  the artifact service.
- `500` — the artifact service rejected the save, or the saved version could not
  be read back. The body carries the reason under `error`.

The route does not check that the session exists, and neither do the sibling
artifact routes.
