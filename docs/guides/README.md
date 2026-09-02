# ADK Developer Guides

This directory contains specific developer guides for the ADK TypeScript
implementation, mirroring the `docs/guides/` tree in
[google/adk-python](https://github.com/google/adk-python/tree/main/docs/guides),
one directory per topic and one guide per feature. For the official ADK
documentation, visit [adk.dev](https://adk.dev/).

## Index

### Sessions

- [User state and temp state](sessions/user_and_temp_state/index.md) - Reading
  `user:` state without a session id, and how `temp:` state stays readable for
  one invocation without reaching storage.
