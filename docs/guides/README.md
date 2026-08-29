# ADK Developer Guides

This directory contains specific developer guides for the ADK TypeScript
implementation. For the official ADK documentation, visit
[adk.dev](https://adk.dev/).

## Index

### Tools

- [adkToMcpToolType and geminiToJsonSchema](tools/mcp_conversion_utils/index.md) - Convert an ADK tool into an MCP tool descriptor so an MCP server can advertise it.
- [ExampleTool.fromConfig](tools/example_tool/index.md) - Building an ExampleTool from a configuration record, and naming an example provider that user code exports.
- [LlamaIndexRetrievalTool](tools/llama_index_retrieval/index.md) - Grounding an agent in a LlamaIndex.TS index you already built, without adding the dependency to ADK.
