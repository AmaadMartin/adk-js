# ADK Developer Guides

This directory contains specific developer guides for the ADK TypeScript
implementation, mirroring the `docs/guides/` tree in adk-python. For the
official ADK documentation, visit [adk.dev](https://adk.dev/).

## Index

### Agents

- [LangGraphAgent](agents/langgraph_agent/index.md) - Running a compiled
  LangGraph state graph as an ADK agent.
- [LlmAgent single-turn and task modes](agents/llm_agent/single_turn.md) - Exposing a sub-agent to its parent as a callable tool that runs inline.

### Auth

- [BaseAuthCredentialExchanger](auth/credential_exchanger/index.md) - The
  OpenAPI tool auth layer's exchange contract, and the error that reports a
  missing credential.
- [Service account tokens for OpenAPI tools](auth/service_account_tokens/index.md) - Access tokens, Cloud Run ID tokens, the quota project header, and the token cache.
- [ToolAuthHandler](auth/tool_auth_handler/index.md) - How an OpenAPI tool gets its credential, keeps it between calls, and refreshes it.

### Examples

- [VertexAiExampleStore](examples/vertex_ai_example_store/index.md) - Reading
  few-shot examples from a curated Vertex AI Example Store instead of from an
  array in your source.

### Memory

- [VertexAiRagMemoryService](memory/vertex_ai_rag_memory_service/index.md) - Storing whole sessions in a Vertex AI RAG corpus, and searching them per app and user.

### Tools

- [adkToMcpToolType and geminiToJsonSchema](tools/mcp_conversion_utils/index.md) - Convert an ADK tool into an MCP tool descriptor so an MCP server can advertise it.
- [AgentTool](tools/agent_tool/index.md) - Exposing an agent to another agent as a callable tool, and the isolation of the nested run.
- [APIHubClient](tools/apihub_client/index.md) - Reading an OpenAPI spec out of Google Cloud API Hub, from a resource path or a Console URL.
- [ApplicationIntegrationToolset](tools/application_integration_toolset/index.md) - Turn a Google Cloud Application Integration integration, or an Integration Connectors connection, into agent tools.
- [BaseTool custom metadata and response scheduling](tools/base_tool/index.md) - Carrying tool metadata, and controlling when a live model reacts to a tool response.
- [ConnectionsClient](tools/connections_client/index.md) - Reading Integration Connectors metadata and building the connector OpenAPI spec from it.
- [ExampleTool.fromConfig](tools/example_tool/index.md) - Building an ExampleTool from a configuration record, and naming an example provider that user code exports.
- [FunctionTool parameters and the sync-callable runner](tools/function_tool/index.md) - How a tool's parameter declaration is built, and how a host keeps a blocking tool body off the event loop.
- [LlamaIndexRetrievalTool](tools/llama_index_retrieval/index.md) - Grounding an agent in a LlamaIndex.TS index you already built, without adding the dependency to ADK.
- [MCP Apps, trace context and HTTP debug capture](tools/mcp_apps/index.md) - Rendering an MCP App next to a tool response, continuing a trace into the MCP server, and reading a failed call's HTTP exchanges.
- [MCPTool authentication and confirmation](tools/mcp_tool/index.md) - Authenticating an MCP tool call, gating it on human approval, and adding per-call headers and progress notifications.
- [OpenAPI parameter and documentation helpers](tools/openapi_common/index.md) - Deriving a tool parameter from an OpenAPI document, and documenting it for a model.
- [OpenApiSpecParser](tools/openapi_spec_parser/index.md) - Reading an OpenAPI document into the operations a REST tool is built from.
- [OpenAPIToolset](tools/openapi_toolset/index.md) - Generating callable tools from an OpenAPI 3 specification, and configuring their authentication and TLS verification.
- [OperationParser](tools/operation_parser/index.md) - How one OpenAPI operation becomes a tool signature: argument names, required arguments, and the generated documentation.
- [preload_memory](tools/preload_memory_tool/index.md) - Recalling earlier conversations automatically, without a tool call.
- [RestApiTool](tools/rest_api_tool/index.md) - Calling one REST endpoint from a model, and configuring it from JSON text.
- [TransferToAgentTool](tools/transfer_to_agent_tool/index.md) - Handing off control to another agent, with the reachable agent names declared to the model.
- [VertexRagRetrievalTool](tools/vertex_rag_retrieval/index.md) - Grounding an agent in a Vertex AI RAG corpus, server-side for Gemini and client-side for every other model.
