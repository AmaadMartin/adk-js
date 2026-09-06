# ADK Developer Guides

This directory contains specific developer guides for the ADK TypeScript
implementation, mirroring the `docs/guides/` tree in
[google/adk-python](https://github.com/google/adk-python/tree/main/docs/guides),
one directory per topic and one guide per feature. For the official ADK
documentation, visit [adk.dev](https://adk.dev/).

## Index

### A2A

- [A2AAgentExecutor](a2a/agent_executor/index.md) - Serving an ADK agent over Agent2Agent: request conversion, the events one execution publishes and the metadata they carry, the converter slots and their declared defaults, interceptors, task result aggregation, how the terminal task state is decided, and cancellation.

### Agents

- [Agent Identity](agents/identity/index.md) - What the framework tells the model about the agent, and how a single-turn agent opts out.
- [AudioCacheManager](agents/audio_cache_manager/index.md) - Buffering a live run's audio chunks and writing each buffer out as one artifact.
- [CodeConfig and AgentRefConfig](agents/common_configs/index.md) - Naming a value defined in code, or another agent, from a configuration document.
- [Context caching](agents/context_caching/index.md) - Reusing a processed
  request prefix across turns, and what the request carries to make that
  decision.
- [Context service wrappers](agents/context/index.md) - Reading and writing artifacts, memory and auth state from a callback or a tool.
- [Declarative LlmAgent configuration](agents/agent_config/index.md) - Describing an agent in a YAML or JSON document, and the references that name code from it.
- [Function call ids in request contents](agents/function_call_ids/index.md) - How a replayed tool call keeps or loses its id, and how a compacted call is recovered.
- [InvocationContext](agents/invocation_context/index.md) - The per-run context: event selection by branch, resumability, the event queue, the LLM-call limit, and the state one run shares — its credential service, its state schema, the custom metadata, the realtime audio caches and the background tool-task registry.
- [LangGraphAgent](agents/langgraph_agent/index.md) - Running a compiled
  LangGraph state graph as an ADK agent.
- [LlmAgent single-turn and task modes](agents/llm_agent/single_turn.md) - Exposing a sub-agent to its parent as a callable tool that runs inline.
- [LoopAgent config documents](agents/loop_agent_config/index.md) - Validating a LoopAgent configuration document, with the same verdict ADK Python gives.
- [mcpInstructionProvider](agents/mcp_instruction_provider/index.md) - Reading an
  agent's instruction from a prompt hosted on an MCP server.
- [Model input context](agents/model_input_context/index.md) - Adding per-turn contents to one LLM request without writing them to the session.
- [Output schema with tools](agents/output_schema_with_tools/index.md) - How an
  agent returns a structured answer on a model that cannot accept a response
  schema and tools in the same request.
- [ParallelAgent](agents/parallel_agent/index.md) - Running sub-agents
  concurrently on isolated branches, and how the fan-out ends.
- [ParallelAgent config documents](agents/parallel_agent_config/index.md) - Validating a ParallelAgent configuration document, with the same verdict ADK Python gives.
- [Per-run request configuration](agents/request_config/index.md) - How `RunConfig` and the agent's own `generateContentConfig` combine into one model request.
- [ReadonlyContext](agents/readonly_context/index.md) - The read-only view of an invocation given to instruction providers, toolsets and plugins.
- [RemoteA2AAgent](agents/remote_a2a_agent/index.md) - Running a remote agent over the A2A protocol, with authentication, card validation, task delegation, the response converter slots, and interceptors on the card fetch and the message send.
- [SequentialAgent config documents](agents/sequential_agent_config/index.md) -
  Validating a `SequentialAgent` configuration document before it reaches your
  code.
- [SequentialAgent resumability](agents/sequential_agent/index.md) - Checkpointing a sequential pipeline so it resumes where it stopped, and pausing it on a human-in-the-loop call.
- [SingleFlow](agents/single_flow/index.md) - The standard request and response processor pipeline an LlmAgent runs, and how to extend it.
- [Static instructions](agents/static_instruction/index.md) - Sending a fixed prompt prefix verbatim, and where the dynamic instruction goes instead.
- [TranscriptionManager](agents/transcription_manager/index.md) - Building correctly-authored events from live-streaming transcriptions, and counting them.

### Apps

- [Events compaction](apps/events_compaction/index.md) - Declaring one
  compaction policy for every agent in an app, and what it guarantees.

### Artifacts

- [Artifact version metadata](artifacts/artifact_version/index.md) - The record
  a service keeps about one saved version: its URI, its creation time, and the
  metadata the caller attached.
- [FileArtifactService](artifacts/file_artifact_service/index.md) - Storing
  artifacts on local disk, with app-scoped layout and atomic version publishing.
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
- [AuthenticatedFunctionTool](auth/authenticated_function_tool/index.md) - A function tool that resolves a credential before it runs, and pauses for user consent when it cannot.
- [BaseAuthenticatedTool](auth/base_authenticated_tool/index.md) - The tool base
  class that resolves a credential before the tool body runs, and the order
  `CredentialManager` resolves it in.
- [BaseAuthCredentialExchanger](auth/credential_exchanger/index.md) - The
  OpenAPI tool auth layer's exchange contract, and the error that reports a
  missing credential.
- [CredentialManager](auth/credential_manager/index.md) - Resolving the credential an authenticated tool runs with, and the provider, exchanger and refresher extension points.
- [OAuth2 credential exchange](auth/oauth2_credential_exchange/index.md) - Trading an authorization code or client credentials for an access token, and what happens when the exchange fails.
- [Service account tokens for OpenAPI tools](auth/service_account_tokens/index.md) - Access tokens, Cloud Run ID tokens, the quota project header, and the token cache.
- [ToolAuthHandler](auth/tool_auth_handler/index.md) - How an OpenAPI tool gets its credential, keeps it between calls, and refreshes it.

### CLI

- [ADK CLI options](cli/cli_options/index.md) - Where a run stores its data, how it reports events, and running one query instead of opening a prompt.
- [adk eval](cli/eval/index.md) - Scoring an agent against recorded eval sets from the command line, and where the run reads and writes.
- [CLI usage metrics](cli/telemetry_metrics/index.md) - The opt-in per-command record the `adk` CLI writes under `~/.adk`, and what it deliberately leaves out.
- [Deploying with ADK Web](cli/deploy_web_ui/index.md) - What `adk deploy --with_ui` changes, and why ADK Web is a development tool.
- [Pub/Sub and Eventarc triggers](cli/triggers/index.md) - Opt-in HTTP endpoints that let an event source invoke an agent, with bounded concurrency and retry on rate limits.

### Code Executors

- [ContainerCodeExecutor](code_executors/container_code_executor/index.md) - Running model-generated code in a hardened Docker container under a wall-clock bound.
- [UnsafeLocalCodeExecutor](code_executors/unsafe_local_code_executor/index.md) - Running model-written code on the local host, and what its result reports.

### Conformance

- [Conformance recordings schema](conformance/recordings_schema/index.md) - The Zod schemas that declare the format of a `generated-recordings.yaml` file.

### Context

- [BaseSummarizer](context/summarizer/index.md) - The strategy a context compactor uses to summarize a window of events, and how a summarizer declines to compact.
- [LlmSummarizer](context/llm_summarizer/index.md) - The built-in summarizer: what it puts in the prompt, how it renders tool traffic, and what the compacted event carries.

### Dev

- [DevServer](dev/dev_server/index.md) - The HTTP server behind `adk web`, and the dev-only endpoints it adds to `AdkApiServer`.

### Evaluation

- [AgentEvaluator](evaluation/agent_evaluator/index.md) - Running an agent over recorded eval data from your own test suite, and reading the verdict it produces.
- [AppDetails](evaluation/app_details/index.md) - The eval system's projection
  of a running app: its agents, their instructions, and the tools each
  declared.
- [Conversation scenarios](evaluation/conversation_scenarios/index.md) - Describing a conversation for a simulated user to have with the agent under test, and the personas it can adopt.
- [EvalCase](evaluation/eval_case/index.md) - The gradable unit of an
  evaluation: a recorded conversation or a scenario, and the accessors that
  read a turn's tool trajectory.
- [Eval config](evaluation/eval_config/index.md) - The `test_config.json` an
  eval run reads: the criteria it scores, the custom metrics it declares, the
  user simulator it selects, and the live timeout it sets.
- [Eval metrics](evaluation/eval_metrics/index.md) - The vocabulary an eval
  config speaks: metric names, criteria, judge model options, thresholds and
  metric results.
- [EvaluationGenerator](evaluation/evaluation_generator/index.md) - Driving an
  agent through a simulated conversation and recording it as gradable
  invocations.
- [Evaluator](evaluation/evaluator/index.md) - The contract an evaluation metric implements, its result shapes, and the criterion type it validates against.
- [Final response match v2](evaluation/final_response_match_v2/index.md) - The LLM-as-a-judge metric that scores an agent's final response against a golden one.
- [Hallucinations v1](evaluation/hallucinations_v1/index.md) - The LLM-as-a-judge metric that scores an agent's response for claims its context does not support.
- [Live eval inference](evaluation/live_inference/index.md) - Driving that same
  simulated conversation over a bidirectional audio connection, for an agent or
  a workflow root, and grading the transcript it produces.
- [LlmAsJudge](evaluation/llm_as_judge/index.md) - Grading an agent's
  invocations with a judge model, and how sampling, parallelism and a failed
  sample are handled.
- [Running an eval locally](evaluation/local_eval_service/index.md) - Running an
  agent over an eval set in your own process, scoring the invocations it
  produced, and registering the metric that scores them.
- [Metric info providers](evaluation/metric_info_providers/index.md) - The name, description and value interval of each prebuilt metric, shared with adk-python.
- [MultiTurnTaskSuccessV1Evaluator](evaluation/multi_turn_task_success_evaluator/index.md) - Scoring whether an agent achieved the goal of a whole conversation, with the Vertex AI Gen AI evaluation service.
- [MultiTurnToolUseQualityV1Evaluator](evaluation/multi_turn_tool_use_quality_evaluator/index.md) - Scoring the tool calls an agent made over a whole conversation, with the Vertex AI Gen AI evaluation service.
- [MultiTurnTrajectoryQualityV1Evaluator](evaluation/multi_turn_trajectory_quality_v1/index.md) -
  Scoring the path an agent took across a whole conversation, not just whether
  it reached the goal.
- [MultiTurnTrajectoryQualityV1Evaluator](evaluation/multi_turn_trajectory_quality_evaluator/index.md) - Scoring the path an agent took across a whole conversation, with the Vertex AI multi-turn trajectory quality metric.
- [PerTurnUserSimulatorQualityV1](evaluation/per_turn_user_simulator_quality_v1/index.md) - Grading the simulated user that drove an eval case: the starting prompt, the conversation plan, and where the conversation should have ended.
- [Pre-built user personas](evaluation/pre_built_personas/index.md) - The user
  personas ADK ships, the behaviors they are built from, and how to compose and
  register one of your own.
- [ResponseEvaluator](evaluation/response_evaluator/index.md) - Scoring an agent's final answer against a golden answer, or against the Vertex AI coherence metric.
- [Rubric based evaluator](evaluation/rubric_based_evaluator/index.md) - The base class for a metric that grades an agent against written rubrics, one verdict per rubric.
- [Rubric based final response quality v1](evaluation/rubric_based_final_response_quality_v1/index.md) - The LLM-as-a-judge metric that scores an agent's final answer against a list of written rubrics.
- [Rubric based multi-turn trajectory evaluator](evaluation/rubric_based_multi_turn_trajectory_evaluator/index.md) - The LLM-as-a-judge metric that scores a whole conversation's trajectory against a list of written rubrics.
- [Rubric based tool use quality v1](evaluation/rubric_based_tool_use_quality_v1/index.md) - The LLM-as-a-judge metric that scores an agent's tool use against a list of written rubrics.
- [SafetyEvaluatorV1](evaluation/safety_evaluator/index.md) - Scoring how
  harmless an agent's answer is, with the Vertex AI safety metric.
- [TrajectoryEvaluator](evaluation/tool_trajectory/index.md) - Scoring the tool
  calls an agent made against a golden trajectory.
- [Choosing the user simulator](evaluation/user_simulator/index.md) - Replaying
  an eval case's static conversation, and dispatching a conversation scenario
  to a registered simulator.
- [Vertex AI eval facades](evaluation/vertex_ai_eval_facade/index.md) - Scoring one invocation, or a whole conversation, with a metric of the Vertex AI Gen AI evaluation service.

### Events

- [Event and NodeInfo](events/event/index.md) - Building events, the message
  alias, and reading node identity out of a node path.
- [EventActions](events/event_actions/index.md) - The side-effects attached to an event: routes, transfers, structured model output, and the two guards that keep them persistable.

### Examples

- [VertexAiExampleStore](examples/vertex_ai_example_store/index.md) - Reading
  few-shot examples from a curated Vertex AI Example Store instead of from an
  array in your source.

### Integrations

- [SlackRunner](integrations/slack_runner/index.md) - Putting an ADK agent behind a Slack bot over Socket Mode, and how a Slack thread maps onto a session.

### Memory

- [BaseMemoryService write paths](memory/base_memory_service/index.md) - The
  optional event-delta and direct-write paths on the memory service contract,
  and the error a caller gets when a service does not support one.
- [MemoryEntry](memory/memory_entry/index.md) - The shape a memory service stores and returns, its defaults, and the fields Vertex AI Memory Bank reads.
- [VertexAiMemoryBankService](memory/vertex_ai_memory_bank/index.md) - Storing conversations in Vertex AI Memory Bank, the two write paths, and structured profiles.
- [VertexAiRagMemoryService](memory/vertex_ai_rag_memory_service/index.md) - Storing whole sessions in a Vertex AI RAG corpus, and searching them per app and user.

### Models

- [CacheMetadata](models/cache_metadata/index.md) - Describing the context cache that served a response, and deciding when to refresh it.
- [ConformanceTestGemini and the replay normalizers](models/conformance_replay/index.md) - Replaying a recorded model call, and verifying the request that asked for it.
- [GeminiContextCacheManager](models/context_caching/index.md) - Reusing a
  stable Gemini prompt prefix through an explicit server-side context cache.
- [gemini_llm_connection](models/gemini_llm_connection/index.md) - Driving a Gemini Live session: replaying history, sending turns and realtime input, and reading responses.
- [Gemini request and response logging](models/gemini_logging/index.md) - Reading the debug dump of a Gemini call, and what it keeps out of the log.
- [Interactions API conversation chaining](models/interactions_api/index.md) - Chaining a turn onto the previous one by id, and how branch scoping decides which events the scan can see.
- [LiteLlm](models/lite_llm/index.md) - Running an agent on a non-Gemini model over the OpenAI chat-completions protocol.
- [LlmRequest](models/llm_request/index.md) - The request object ADK builds for one model call, and the rules that keep it valid for the provider.

### Optimization

- [Agent optimization data types](optimization/data_types/index.md) - The vocabulary a sampler and an optimizer share: per-example scores and a Pareto front of optimized agents.
- [LocalEvalSampler](optimization/local_eval_sampler/index.md) - Scoring a
  candidate agent against your ADK eval sets, so an optimizer can rank it.

### Planners

- [BasePlanner](planners/planner/index.md) - Applying an agent's planner to the model request, and splitting the reply into a plan and an answer.

### Platform

- [createThread](platform/thread/index.md) - Background work with a seam that lets a host platform supply its own execution unit.

### Plugins

- [BigQueryAgentAnalyticsPlugin](plugins/bigquery_agent_analytics_plugin/index.md) - Streaming agent lifecycle events into a BigQuery table so behaviour, cost and failures can be queried in SQL.
- [Context filtering](plugins/context_filter/index.md) - Trimming the history one model call sees: the invocation window, the hysteresis that stops it re-truncating every turn, and the function-call pairing it preserves.
- [DebugLoggingPlugin](plugins/debug_logging/index.md) - Recording a complete on-disk trace of every invocation, with credentials redacted.
- [Plugin agent callbacks](plugins/agent_callbacks/index.md) - The agent lifecycle hooks a plugin gets, their precedence over an agent's own callbacks, and the agent error notification.
- [Plugin close lifecycle](plugins/plugin_close_lifecycle/index.md) - Releasing
  the resources a plugin holds, and the timeout that bounds each shutdown.
- [ReplayPlugin](plugins/replay_plugin/index.md) - Replaying a recorded conformance run, and failing it when the agent drifts from the recording.
- [Run error notifications](plugins/run_error_notifications/index.md) - Telling
  every plugin that an error escaped a run, without letting a plugin replace
  it.

### Runner

- [Choosing a Runner entry point](runner/run_entry_points/index.md) - When to
  run an invocation ahead of the caller that reads it, and what that changes.
- [Live mode](runner/live_mode/index.md) - Running an agent or a workflow over a bidirectional stream, and the events that reach the caller from underneath the root.
- [Resuming an invocation](runner/invocation_resume/index.md) - How the runner
  decides which invocation a message belongs to, and how to resume one.
- [Starting a run](runner/starting_a_run/index.md) - How the runner finds or
  creates a run's session, and how to give it its root.

### Server

- [Configuring the ADK API server](server/api_server_configuration/index.md) - The credential service, automatic session creation and URL prefix options of `AdkApiServer`.
- [CORS origins](server/cors_origins/index.md) - Accepting a family of browser origins with one `regex:` pattern, and the deprecated `AdkWebServer` alias.

### Sessions

- [DatabaseSessionService](sessions/database_session_service/index.md) -
  Storing sessions in SQL, the connection URLs it accepts, the engine settings
  each backend gets, which backends take a row-level lock, how a timestamp is
  stored, rejecting stale writes, reading user state, releasing the connection
  pool, and opening a legacy database adk-python wrote.
- [FirestoreSessionService](sessions/firestore_session_service/index.md) -
  Storing sessions in Google Cloud Firestore, in the document layout adk-python
  writes, with revision-checked appends and one state document per scope.
- [Migrating a pickle sessions database](sessions/pickle_migration/index.md) - Copying an adk-python v0 (pickle) sessions database into the v1 (JSON) layout `DatabaseSessionService` can open.
- [Session resolution](sessions/session_resolution/index.md) - How a runner
  resolves the session id you give it, and when it creates a missing session.
- [Session state and its scopes](sessions/state/index.md) - Session state and
  the app:, user: and temp: prefixes that decide what is shared and what is
  stored.
- [SqliteSessionService](sessions/sqlite_session_service/index.md) - Durable
  sessions in one local SQLite file, in the layout adk-python reads.
- [The legacy v0 session schema](sessions/legacy_v0_schema/index.md) - Reading
  and writing a sessions database that adk-python 1.19.0 to 1.21.0 created,
  including the restricted decoder for its pickled event actions.
- [User state and temp state](sessions/user_and_temp_state/index.md) - Reading
  `user:` state without a session id, and how `temp:` state stays readable for
  one invocation without reaching storage.
- [VertexAiSessionService](sessions/vertex_ai_session_service/index.md) -
  Storing sessions in Vertex AI Agent Engine, its session-id rules, Express
  Mode, and what it does not support.

### Skills

- [Frontmatter, Resources and Skill](skills/skill_model/index.md) - How a SKILL.md directory becomes a Skill, the name rules, and the resource accessors.

### Telemetry

- [Experimental GenAI semantic conventions](telemetry/experimental_semconv/index.md) - Emitting the experimental OpenTelemetry GenAI attributes and the completion-details log record.
- [Google Cloud telemetry export](telemetry/google_cloud/index.md) - Sending an
  agent's traces, metrics and log records to Google Cloud over OTLP.
- [SqliteSpanExporter](telemetry/sqlite_span_exporter/index.md) - Persisting OpenTelemetry spans to a local SQLite file and reading them back by session.

### Tools

- [adkToMcpToolType and geminiToJsonSchema](tools/mcp_conversion_utils/index.md) - Convert an ADK tool into an MCP tool descriptor so an MCP server can advertise it.
- [AgentRegistry](tools/agent_registry/index.md) - Resolving a registered MCP server or A2A agent into a ready-to-use ADK component, with its endpoint and credentials already resolved.
- [AgentTool](tools/agent_tool/index.md) - Exposing an agent to another agent as a callable tool: the isolation of the nested run, the arguments it accepts, the run settings it inherits, and when the sub-runner is released.
- [APIHubClient](tools/apihub_client/index.md) - Reading an OpenAPI spec out of Google Cloud API Hub, from a resource path or a Console URL.
- [ApiRegistry](tools/api_registry/index.md) - Building an MCP toolset from a
  server registered in Cloud API Registry, and why to prefer `AgentRegistry`.
- [ApplicationIntegrationToolset](tools/application_integration_toolset/index.md) - Turn a Google Cloud Application Integration integration, or an Integration Connectors connection, into agent tools.
- [BaseComputer and ComputerUseToolset](tools/computer_use/index.md) - Driving a browser with a Gemini computer-use model: the interface you implement, and the coordinate and URL-safety rules the toolset applies.
- [BaseRetrievalTool](tools/base_retrieval_tool/index.md) - The shared `query`
  declaration every retrieval tool contributes, and the two shapes it takes.
- [BaseTool custom metadata and response scheduling](tools/base_tool/index.md) - Carrying tool metadata, and controlling when a live model reacts to a tool response.
- [Bigtable tool settings](tools/bigtable_tool_settings/index.md) - Capping how many rows a Bigtable query returns, and the experimental flag that gates the settings.
- [BigtableCredentialsConfig](tools/bigtable_credentials/index.md) - How a Bigtable tool authenticates, and the scopes and token cache key it defaults to.
- [BigtableToolset](tools/bigtable_toolset/index.md) - Read-only Bigtable tools for an agent: instance, table and cluster metadata, plus GoogleSQL queries under a row cap.
- [ConnectionsClient](tools/connections_client/index.md) - Reading Integration Connectors metadata and building the connector OpenAPI spec from it.
- [DataAgentToolset](tools/data_agent_toolset/index.md) - Ask a Conversational Analytics data agent questions in plain language, and manage those data agents.
- [DiscoveryEngineSearchTool](tools/discovery_engine_search/index.md) - Searching a Vertex AI Search data store from any model, with endpoint resolution and result-mode detection.
- [Environment simulation config](tools/environment_simulation_config/index.md) - Declaring how a tool is simulated instead of called: injection rules, mock strategies, and the deprecated `AgentSimulatorConfig` name.
- [EnvironmentToolset](tools/environment_toolset/index.md) - Giving an agent a working directory it can run commands in, read files from and edit, and the confirmation gate on shell execution.
- [ExampleTool.fromConfig](tools/example_tool/index.md) - Building an ExampleTool from a configuration record, and naming an example provider that user code exports.
- [FunctionTool parameters and the sync-callable runner](tools/function_tool/index.md) - How a tool's parameter declaration is built, and how a host keeps a blocking tool body off the event loop.
- [GoogleApiToolset](tools/google_api_toolset/index.md) - Turning a Google API Discovery document into callable tools, and the credentials they run under.
- [GoogleSearchAgentTool](tools/google_search_agent/index.md) - Running Google
  Search in a sub-agent so it can sit beside your agent's other tools.
- [GoogleSearchTool](tools/google_search/index.md) - Grounding a Gemini model's
  answers in Google Search, and the requests the tool accepts.
- [GoogleTool](tools/google_tool/index.md) - Handcrafting a Google API tool, and the OAuth handshake and token cache it manages for you.
- [GoogleTool with credential injection](tools/google_tool_credential_injection/index.md) - Calling a Google API from a
  handcrafted tool, with credential resolution and argument injection.
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
- [SetModelResponseTool](tools/set_model_response/index.md) - Returning structured output on a model that cannot take an output schema and tools in one request.
- [Spanner tool settings](tools/spanner_tool_settings/index.md) - Configuring what the Spanner tools may do, how they shape query results, and the vector store they search.
- [SpannerToolset](tools/spanner_toolset/index.md) - Reading Spanner tables,
  schemas and vector columns from an agent, with read-only access and
  per-user credentials.
- [Tool connection map](tools/tool_connection_map/index.md) - Describing which parameters a set of tools shares, and which tool creates or consumes each one.
- [ToolboxToolset](tools/toolbox_toolset/index.md) - Loading tools from an MCP
  Toolbox for Databases server, with named toolsets, bound parameters and
  authentication.
- [ToolConfig](tools/tool_config/index.md) - Declaring a tool in a configuration file, and validating that declaration at load time.
- [ToolConfirmation](tools/tool_confirmation/index.md) - Reading a human
  approval out of the function response a client sends back, and the two
  shapes it may arrive in.
- [Toolset tool-name prefixing](tools/base_toolset/index.md) - Giving a toolset a name prefix, what the invocation cache guarantees, and the `close`, `fromConfig` and `getAuthConfig` hooks.
- [TransferToAgentTool](tools/transfer_to_agent_tool/index.md) - Handing off control to another agent, with the reachable agent names declared to the model.
- [UrlContextTool](tools/url_context/index.md) - Letting a Gemini model fetch and read the URLs a user mentions.
- [VertexRagRetrievalTool](tools/vertex_rag_retrieval/index.md) - Grounding an agent in a Vertex AI RAG corpus, server-side for Gemini and client-side for every other model.
