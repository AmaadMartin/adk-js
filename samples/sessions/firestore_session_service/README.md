# Sessions in Firestore

`run.ts` drives `FirestoreSessionService` through one full round trip against a
real Firestore: it creates a session, appends two events, reads the session
back, lists it, watches a stale copy get rejected, and deletes it. Nothing is
stubbed, so a successful run is evidence the service works against the actual
client.

## Requirements

- `@google-cloud/firestore`, which `@google/adk` declares as an optional peer
  dependency and does not install for you:

  ```bash
  npm install @google-cloud/firestore
  ```

- A Firestore to talk to, either the emulator or a real project.

## Against the emulator

The emulator needs no credentials, and the project id can be anything:

```bash
gcloud emulators firestore start --host-port=127.0.0.1:8080

FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GOOGLE_CLOUD_PROJECT=demo-adk \
  npx tsx samples/sessions/firestore_session_service/run.ts
```

## Against a real project

Configure application default credentials, then name the project:

```bash
gcloud auth application-default login

GOOGLE_CLOUD_PROJECT=my-project \
  npx tsx samples/sessions/firestore_session_service/run.ts
```

The script writes under the `adk-session` root collection. Set
`ADK_FIRESTORE_ROOT_COLLECTION` to write somewhere else. It deletes the session
it created, but leaves the `app_states` and `user_states` documents behind,
because those are shared by every session of the app.

For the document layout, the concurrency contract and the index
`listSessions` needs, see
[the guide](../../../docs/guides/sessions/firestore_session_service/index.md).
