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

```ts
import {Part} from '@google/genai';

async function saveArtifact(
  baseUrl: string,
  filename: string,
  artifact: Part,
): Promise<{version: number}> {
  const response = await fetch(
    `${baseUrl}/apps/get_started/users/u/sessions/s/artifacts`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({filename, artifact}),
    },
  );

  return (await response.json()) as {version: number};
}
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
