# ADK Developer Guides

This directory contains specific developer guides for the ADK TypeScript
implementation, mirroring the `docs/guides/` tree in
[google/adk-python](https://github.com/google/adk-python/tree/main/docs/guides),
one directory per topic and one guide per feature. For the official ADK
documentation, visit [adk.dev](https://adk.dev/).

## Index

### Agents

- [Agent Identity](agents/identity/index.md) - What the framework tells the model about the agent, and how a single-turn agent opts out.
- [Context caching](agents/context_caching/index.md) - Reusing a processed
  request prefix across turns, and what the request carries to make that
  decision.
- [Function call ids in request contents](agents/function_call_ids/index.md) - How a replayed tool call keeps or loses its id, and how a compacted call is recovered.
- [InvocationContext](agents/invocation_context/index.md) - The per-run context: event selection by branch, resumability, the event queue, and the LLM-call limit.
- [LangGraphAgent](agents/langgraph_agent/index.md) - Running a compiled
  LangGraph state graph as an ADK agent.
- [LlmAgent single-turn and task modes](agents/llm_agent/single_turn.md) - Exposing a sub-agent to its parent as a callable tool that runs inline.
- [Model input context](agents/model_input_context/index.md) - Adding per-turn contents to one LLM request without writing them to the session.
- [ParallelAgent](agents/parallel_agent/index.md) - Running sub-agents
  concurrently on isolated branches, and how the fan-out ends.
- [Per-run request configuration](agents/request_config/index.md) - How `RunConfig` and the agent's own `generateContentConfig` combine into one model request.
- [ReadonlyContext](agents/readonly_context/index.md) - The read-only view of an invocation given to instruction providers, toolsets and plugins.
- [SequentialAgent resumability](agents/sequential_agent/index.md) - Checkpointing a sequential pipeline so it resumes where it stopped, and pausing it on a human-in-the-loop call.
- [SingleFlow](agents/single_flow/index.md) - The standard request and response processor pipeline an LlmAgent runs, and how to extend it.
- [Static instructions](agents/static_instruction/index.md) - Sending a fixed prompt prefix verbatim, and where the dynamic instruction goes instead.

### Apps

- [Events compaction](apps/events_compaction/index.md) - Declaring one
  compaction policy for every agent in an app, and what it guarantees.

### Artifacts

- [Artifact version metadata](artifacts/artifact_version/index.md) - The record
  a service keeps about one saved version: its URI, its creation time, and the
  metadata the caller attached.
- [InMemoryArtifactService](artifacts/in_memory_artifact_service/index.md) - The in-process artifact store, its scoping and version indexing, and how to seed it in a test.

### Auth

- [Auth schemes](auth/auth_schemes/index.md) - Declaring how an API expects to
  be authenticated, including custom scheme types and OAuth2 endpoint
  discovery.
- [AuthCredential and its helpers](auth/auth_credential/index.md) - Building a
  credential with the right defaults, rejecting one that cannot work, and
  logging one without leaking the secret.
- [Authenticated tools and the credential key](auth/tool_auth/index.md) - How a
  tool asks for a user credential, and which calls resume once it arrives.
- [BaseAuthCredentialExchanger](auth/credential_exchanger/index.md) - The
  OpenAPI tool auth layer's exchange contract, and the error that reports a
  missing credential.
- [Service account tokens for OpenAPI tools](auth/service_account_tokens/index.md) - Access tokens, Cloud Run ID tokens, the quota project header, and the token cache.
- [ToolAuthHandler](auth/tool_auth_handler/index.md) - How an OpenAPI tool gets its credential, keeps it between calls, and refreshes it.

### CLI

- [ADK CLI options](cli/cli_options/index.md) - Where a run stores its data, how it reports events, and running one query instead of opening a prompt.
- [adk eval](cli/eval/index.md) - Scoring an agent against recorded eval sets from the command line, and where the run reads and writes.

### Code Executors

- [ContainerCodeExecutor](code_executors/container_code_executor/index.md) - Running model-generated code in a hardened Docker container under a wall-clock bound.
- [UnsafeLocalCodeExecutor](code_executors/unsafe_local_code_executor/index.md) - Running model-written code on the local host, and what its result reports.

### Evaluation

- [EvaluationGenerator](evaluation/evaluation_generator/index.md) - Driving an
  agent through a simulated conversation and recording it as gradable
  invocations.
- [Live eval inference](evaluation/live_inference/index.md) - Driving that same
  simulated conversation over a bidirectional audio connection, for an agent or
  a workflow root, and grading the transcript it produces.
- [ResponseEvaluator](evaluation/response_evaluator/index.md) - Scoring an agent's final answer against a golden answer, or against the Vertex AI coherence metric.
- [TrajectoryEvaluator](evaluation/tool_trajectory/index.md) - Scoring the tool
  calls an agent made against a golden trajectory.
- [Choosing the user simulator](evaluation/user_simulator/index.md) - Replaying
  an eval case's static conversation, and driving a case that has none.

### Events

- [Event and NodeInfo](events/event/index.md) - Building events, the message
  alias, and reading node identity out of a node path.
- [EventActions](events/event_actions/index.md) - The side-effects attached to an event: routes, transfers, structured model output, and the two guards that keep them persistable.

### Examples

- [VertexAiExampleStore](examples/vertex_ai_example_store/index.md) - Reading
  few-shot examples from a curated Vertex AI Example Store instead of from an
  array in your source.

### Memory

- [BaseMemoryService write paths](memory/base_memory_service/index.md) - The
  optional event-delta and direct-write paths on the memory service contract,
  and the error a caller gets when a service does not support one.
- [VertexAiRagMemoryService](memory/vertex_ai_rag_memory_service/index.md) - Storing whole sessions in a Vertex AI RAG corpus, and searching them per app and user.

### Models

- [gemini_llm_connection](models/gemini_llm_connection/index.md) - Driving a Gemini Live session: replaying history, sending turns and realtime input, and reading responses.
- [Gemini request and response logging](models/gemini_logging/index.md) - Reading the debug dump of a Gemini call, and what it keeps out of the log.
- [LiteLlm](models/lite_llm/index.md) - Running an agent on a non-Gemini model over the OpenAI chat-completions protocol.
- [LlmRequest](models/llm_request/index.md) - The request object ADK builds for one model call, and the rules that keep it valid for the provider.

### Planners

- [BasePlanner](planners/planner/index.md) - Applying an agent's planner to the model request, and splitting the reply into a plan and an answer.

### Plugins

- [Plugin agent callbacks](plugins/agent_callbacks/index.md) - The agent lifecycle hooks a plugin gets, their precedence over an agent's own callbacks, and the agent error notification.

### Runner

- [Choosing a Runner entry point](runner/run_entry_points/index.md) - When to
  run an invocation ahead of the caller that reads it, and what that changes.
- [Resuming an invocation](runner/invocation_resume/index.md) - How the runner
  decides which invocation a message belongs to, and how to resume one.
- [Starting a run](runner/starting_a_run/index.md) - How the runner finds or
  creates a run's session, and how to give it its root.

### Sessions

- [DatabaseSessionService](sessions/database_session_service/index.md) -
  Storing sessions in SQL, the connection URLs it accepts, rejecting stale
  writes, reading user state, and opening a legacy database adk-python wrote.
- [Session state and its scopes](sessions/state/index.md) - Session state and
  the app:, user: and temp: prefixes that decide what is shared and what is
  stored.
- [User state and temp state](sessions/user_and_temp_state/index.md) - Reading
  `user:` state without a session id, and how `temp:` state stays readable for
  one invocation without reaching storage.
- [VertexAiSessionService](sessions/vertex_ai_session_service/index.md) -
  Storing sessions in Vertex AI Agent Engine, its session-id rules, Express
  Mode, and what it does not support.

### Tools

- [adkToMcpToolType and geminiToJsonSchema](tools/mcp_conversion_utils/index.md) - Convert an ADK tool into an MCP tool descriptor so an MCP server can advertise it.
- [AgentTool](tools/agent_tool/index.md) - Exposing an agent to another agent as a callable tool: the isolation of the nested run, the arguments it accepts, the run settings it inherits, and when the sub-runner is released.
- [APIHubClient](tools/apihub_client/index.md) - Reading an OpenAPI spec out of Google Cloud API Hub, from a resource path or a Console URL.
- [ApplicationIntegrationToolset](tools/application_integration_toolset/index.md) - Turn a Google Cloud Application Integration integration, or an Integration Connectors connection, into agent tools.
- [BaseRetrievalTool](tools/base_retrieval_tool/index.md) - The shared `query`
  declaration every retrieval tool contributes, and the two shapes it takes.
- [BaseTool custom metadata and response scheduling](tools/base_tool/index.md) - Carrying tool metadata, and controlling when a live model reacts to a tool response.
- [ConnectionsClient](tools/connections_client/index.md) - Reading Integration Connectors metadata and building the connector OpenAPI spec from it.
- [ExampleTool.fromConfig](tools/example_tool/index.md) - Building an ExampleTool from a configuration record, and naming an example provider that user code exports.
- [FunctionTool parameters and the sync-callable runner](tools/function_tool/index.md) - How a tool's parameter declaration is built, and how a host keeps a blocking tool body off the event loop.
- [GoogleSearchTool](tools/google_search/index.md) - Grounding a Gemini model's
  answers in Google Search, and the requests the tool accepts.
- [LlamaIndexRetrievalTool](tools/llama_index_retrieval/index.md) - Grounding an agent in a LlamaIndex.TS index you already built, without adding the dependency to ADK.
- [MCP Apps, trace context and HTTP debug capture](tools/mcp_apps/index.md) - Rendering an MCP App next to a tool response, continuing a trace into the MCP server, and reading a failed call's HTTP exchanges.
- [MCPTool authentication and confirmation](tools/mcp_tool/index.md) - Authenticating an MCP tool call, gating it on human approval, and adding per-call headers and progress notifications.
- [MCPToolset configuration and call guards](tools/mcp_toolset/index.md) - Building an MCPToolset from an agent config, the stdio opt-in, and the timeout, retry and reserved-name guards on every call.
- [OpenAPI parameter and documentation helpers](tools/openapi_common/index.md) - Deriving a tool parameter from an OpenAPI document, and documenting it for a model.
- [OpenApiSpecParser](tools/openapi_spec_parser/index.md) - Reading an OpenAPI document into the operations a REST tool is built from.
- [OpenAPIToolset](tools/openapi_toolset/index.md) - Generating callable tools from an OpenAPI 3 specification, and configuring their authentication and TLS verification.
- [OperationParser](tools/operation_parser/index.md) - How one OpenAPI operation becomes a tool signature: argument names, required arguments, and the generated documentation.
- [preload_memory](tools/preload_memory_tool/index.md) - Recalling earlier conversations automatically, without a tool call.
- [RestApiTool](tools/rest_api_tool/index.md) - Calling one REST endpoint from a model, and configuring it from JSON text.
- [RestApiTool request timeouts](tools/rest_api_tool_timeouts/index.md) - Bounding one REST API call, and the error a timeout returns to the model.
- [TransferToAgentTool](tools/transfer_to_agent_tool/index.md) - Handing off control to another agent, with the reachable agent names declared to the model.
- [VertexRagRetrievalTool](tools/vertex_rag_retrieval/index.md) - Grounding an agent in a Vertex AI RAG corpus, server-side for Gemini and client-side for every other model.
