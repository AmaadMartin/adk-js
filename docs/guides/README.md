# ADK Developer Guides

This directory contains specific developer guides for the ADK TypeScript
implementation, mirroring the `docs/guides/` tree in
[google/adk-python](https://github.com/google/adk-python/tree/main/docs/guides),
one directory per topic and one guide per feature. For the official ADK
documentation, visit [adk.dev](https://adk.dev/).

## Index

### Plugins

- [AutoTracingPlugin](plugins/auto_tracing/index.md) - Emitting an OpenTelemetry span for every function an agent reaches, with the call's arguments and result masked of credentials.
