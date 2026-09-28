# Session patch and artifact version metadata

Three routes on the ADK API server let a client change session state and read
artifact version metadata without running the agent. Reach for them when a UI or
a script must seed state, or must show what versions an artifact has.

## Introduction

The API server that `adk web` and `adk api_server` start is the HTTP face of the
SDK. Most of its routes run the agent. These three do not.

`PATCH /apps/{app}/users/{user}/sessions/{session}` applies a state delta to a
session. Without it, the only way to write session state over HTTP is to run a
turn through `/run` with a `stateDelta`, which costs a model call the caller did
not want. The patch appends one event authored by `user`, so the change stays
visible in the session history rather than appearing out of nowhere.

The two metadata routes answer a different question from the payload routes.
`GET .../artifacts/{name}/versions` returns bare version numbers, and
`GET .../artifacts/{name}` returns the bytes. Neither tells a client the MIME
type or the custom metadata of a version, so a version picker had to download
every payload to render a list. `.../versions/metadata` returns an
`ArtifactVersion` per version, and `.../versions/{id}/metadata` returns one.

All three match `adk-python`'s API server, so a tool written against the Python
server's HTTP contract now works against the TypeScript one.

## Get started

`AdkApiClient` wraps the three routes.

```ts
import {AdkApiClient} from '@google/adk-devtools';

const client = new AdkApiClient({backendUrl: 'http://localhost:8000'});

const session = await client.updateSession({
  appName: 'demo',
  userId: 'u1',
  sessionId: 's1',
  stateDelta: {mode: 'beta'},
});
console.log(session.state); // {existing: 'kept', mode: 'beta'}

const latest = await client.getArtifactVersionMetadata({
  appName: 'demo',
  userId: 'u1',
  sessionId: 's1',
  artifactName: 'a.txt',
  version: 'latest',
});
console.log(latest); // {version: 1, customMetadata: {stage: 'second'}}

const all = await client.listArtifactVersionsMetadata({
  appName: 'demo',
  userId: 'u1',
  sessionId: 's1',
  artifactName: 'a.txt',
});
console.log(all.map((v) => v.version)); // [0, 1]
```

## The patch body

The server reads the delta from `stateDelta` and also from `state_delta`.
`adk-python` declares the field as `state_delta` and generates a camel-case
alias over it, so both spellings reach the same handler in both SDKs.

A body without either key is a `422`. The delta is required, so an empty patch
is an error rather than a silent no-op that appends an empty event.

## State scope

A delta key decides how far the write reaches. A plain key writes session state.
A key prefixed `app:` writes state shared by every session of the app, and
`user:` writes state shared by every session of that user. A caller can
therefore reach beyond the session named in the URL:

```bash
curl -X PATCH localhost:8000/apps/demo/users/u1/sessions/s1 \
  -H 'Content-Type: application/json' -d '{"stateDelta":{"user:tier":"gold"}}'
```

`adk-python` behaves the same way. Treat the route as trusted-caller only, and
put an authenticating proxy in front of the server if it is reachable by anyone
else.

A key prefixed `temp:` is dropped before the event is stored. A patch carrying
only `temp:` keys answers `200` and leaves the stored state unchanged.

## Version ids

`{version_id}` is a decimal integer or the literal `latest`. `latest` resolves
to the newest version, so a client can inspect it without knowing its number.
Anything else is a `422`, which separates a malformed request from a version
that does not exist. A version that does not exist is a `404`.

Every error body is `{"error": "<message>"}`, which is the envelope the whole JS
API server uses. `adk-python` sends `{"detail": ...}`. The status codes match
across the two SDKs; the envelope does not.
