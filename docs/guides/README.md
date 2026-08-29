# ADK Developer Guides

This directory contains specific developer guides for the ADK TypeScript
implementation, mirroring the `docs/guides/` tree in adk-python. For the
official ADK documentation, visit [adk.dev](https://adk.dev/).

## Index

### Auth

- [BaseAuthCredentialExchanger](auth/credential_exchanger/index.md) - The
  OpenAPI tool auth layer's exchange contract, and the error that reports a
  missing credential.

### Tools

- [adkToMcpToolType and geminiToJsonSchema](tools/mcp_conversion_utils/index.md) - Convert an ADK tool into an MCP tool descriptor so an MCP server can advertise it.
- [APIHubClient](tools/apihub_client/index.md) - Reading an OpenAPI spec out of Google Cloud API Hub, from a resource path or a Console URL.
- [ExampleTool.fromConfig](tools/example_tool/index.md) - Building an ExampleTool from a configuration record, and naming an example provider that user code exports.
- [LlamaIndexRetrievalTool](tools/llama_index_retrieval/index.md) - Grounding an agent in a LlamaIndex.TS index you already built, without adding the dependency to ADK.
- [OpenApiSpecParser](tools/openapi_spec_parser/index.md) - Reading an OpenAPI document into the operations a REST tool is built from.
- [OpenAPIToolset](tools/openapi_toolset/index.md) - Generating callable tools from an OpenAPI 3 specification, and configuring their authentication and TLS verification.
- [VertexRagRetrievalTool](tools/vertex_rag_retrieval/index.md) - Grounding an agent in a Vertex AI RAG corpus, server-side for Gemini and client-side for every other model.
