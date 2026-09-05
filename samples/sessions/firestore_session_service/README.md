# A Firestore session round trip

`round_trip.ts` drives `FirestoreSessionService` end to end: it creates a
session with `app:`, `user:`, `temp:` and plain state, appends two events,
re-reads the session, lists the app's sessions, then deletes the session and
shows the read returning `undefined`.

The service needs the `@google-cloud/firestore` optional peer dependency:

```bash
npm install @google-cloud/firestore
```

## Against the emulator

The emulator needs no credentials and no project, so this is the quickest way
to run the sample:

```bash
gcloud emulators firestore start --host-port=localhost:8080
```

```bash
FIRESTORE_EMULATOR_HOST=localhost:8080 \
  npx tsx samples/sessions/firestore_session_service/round_trip.ts
```

## Against a real project

Set your project and have Application Default Credentials in place:

```bash
gcloud auth application-default login
GOOGLE_CLOUD_PROJECT=your-project-id \
  npx tsx samples/sessions/firestore_session_service/round_trip.ts
```

The sample writes under the `adk-session` root collection, plus one document in
`app_states` and one in `user_states`. It deletes the session it created; the
two state documents are left, because they are shared with every other session
of that app and user.

With neither variable set the sample prints the instruction above and exits,
rather than hanging while a client looks for credentials.

For the document layout, the state scopes and the failure modes, see
[the guide](../../../docs/guides/sessions/firestore_session_service/index.md).
