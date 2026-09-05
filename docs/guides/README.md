# ADK Developer Guides

This directory contains specific developer guides for the ADK TypeScript
implementation, mirroring the `docs/guides/` tree in
[google/adk-python](https://github.com/google/adk-python/tree/main/docs/guides),
one directory per topic and one guide per feature. For the official ADK
documentation, visit [adk.dev](https://adk.dev/).

## Index

### Tools

- [Spanner tool settings](tools/spanner_tool_settings/index.md) - Configuring what the Spanner tools may do, how they shape query results, and the vector store they search.
- [SpannerAdminToolset](tools/spanner_admin_toolset/index.md) - Listing and
  creating Spanner instances and databases from an agent, and limiting it to
  the read-only tools.
- [SpannerToolset](tools/spanner_toolset/index.md) - Reading Spanner tables,
  schemas and vector columns from an agent, with read-only access and
  per-user credentials.
