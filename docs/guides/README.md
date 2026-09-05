# ADK Developer Guides

This directory contains specific developer guides for the ADK TypeScript
implementation, mirroring the `docs/guides/` tree in
[google/adk-python](https://github.com/google/adk-python/tree/main/docs/guides),
one directory per topic and one guide per feature. For the official ADK
documentation, visit [adk.dev](https://adk.dev/).

## Index

### Sessions

- [FirestoreSessionService](sessions/firestore_session_service/index.md) -
  Storing sessions in Google Cloud Firestore: the document layout it shares
  with adk-python, the state scopes, rejecting stale writes, the index
  `listSessions` needs, and what a delete removes.
