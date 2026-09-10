# ADK Developer Guides

This directory contains specific developer guides for the ADK TypeScript
implementation, mirroring the `docs/guides/` tree in
[google/adk-python](https://github.com/google/adk-python/tree/main/docs/guides),
one directory per topic and one guide per feature. For the official ADK
documentation, visit [adk.dev](https://adk.dev/).

## Index

### Plugins

- [Plugin close lifecycle](plugins/plugin_close_lifecycle/index.md) - Releasing
  the resources a plugin holds, and the timeout that bounds each shutdown.
- [Run error notifications](plugins/run_error_notifications/index.md) - Telling
  every plugin that an invocation failed, without letting one swallow the error.
