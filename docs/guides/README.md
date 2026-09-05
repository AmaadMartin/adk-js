# ADK Developer Guides

This directory contains specific developer guides for the ADK JavaScript and
TypeScript implementation. One guide per feature, mirroring adk-python's
`docs/guides/` layout, so the two SDKs document a feature in the same place. For
the official ADK documentation, visit [adk.dev](https://adk.dev/).

Maintainers may prefer these on adk.dev instead. Moving them is a file move.

## Index

### A2A

- [A2AAgentExecutor](a2a/agent_executor/index.md) - Serving an ADK agent over
  the Agent2Agent protocol, and the events it publishes.

### Agents

- [Agent info](agents/agent_info/index.md) - Flattening an agent tree into
  per-agent metadata, with resolved tool declarations, so a host can describe an
  app without running it.
- [AudioTranscriber](agents/audio_transcriber/index.md) - Turning an
  invocation's buffered audio into text Content with Cloud Speech-to-Text.
- [BasePlanner](agents/planner/index.md) - Making an agent plan before it
  answers, and marking its reasoning as thought parts.
- [LlmAgent single-turn and task modes](agents/llm_agent/single_turn.md) -
  Exposing a sub-agent to its parent as a callable tool that runs inline.
- [Static instructions](agents/static_instruction/index.md) - Splitting an
  agent's prompt into a cacheable static prefix and a per-turn dynamic
  instruction.

### Evaluation

- [BaseEvalService](evaluation/eval_service/index.md) - The two-phase eval
  contract: run the agent over an eval set, then score the results.
- [Multi-turn task success evaluator](evaluation/multi_turn_task_success_evaluator/index.md) -
  Scoring whether an agent achieved the goal of a whole conversation.
- [Session to eval format](evaluation/session_to_eval_format/index.md) - Turning
  a recorded session into eval-set turn records.
- [TrajectoryEvaluator](evaluation/trajectory_evaluator/index.md) - Scoring an
  agent's tool calls against a golden trajectory, and the `Evaluator` seam every
  metric sits behind.

### Events

- [Event and NodeInfo](events/event/index.md) - The event fields, the
  convenience construction options, and reading the emitting workflow node.

### Labs

- [AntigravityAgent](labs/antigravity/index.md) - Running a Google Antigravity
  agent as an ADK agent node.

### Models

- [Anthropic Claude models](models/anthropic/index.md) - Driving an agent with
  Claude, through the Anthropic API or Vertex AI.
- [Configuring the Gemini model](models/gemini_config/index.md) - Choosing
  the endpoint, API version, client and retries, and handling an exhausted
  quota.
- [ConformanceTestGemini](models/conformance_replay/index.md) - Replaying
  recorded LLM responses, and verifying that the runtime asked for what was
  recorded.
- [Live responses](models/live_responses/index.md) - Reading a Gemini Live run:
  which response field carries what, how grounding accumulates, and how Gemini
  3.x differs.
- [OpenAILlm](models/openai/index.md) - Running an agent on a GPT model, or on
  any host that speaks the OpenAI Chat Completions API.

### Sessions

- [DatabaseSessionService](sessions/database_session_service/index.md) - Storing
  sessions in a SQL database, and tuning the MikroORM connection behind them.

### Tools

- [adkToMcpToolType and geminiToJsonSchema](tools/mcp_conversion_utils/index.md) -
  Convert an ADK tool into an MCP tool descriptor so an MCP server can
  advertise it.
- [APIHubToolset](tools/apihub_toolset/index.md) - Building agent tools from an
  API Hub specification, and controlling when it is fetched.
- [BigQuery tool config](tools/bigquery_tool_config/index.md) - Configuring what
  the BigQuery tools may write, how much a query may cost, and the labels their
  jobs carry.
- [LlamaIndexRetrievalTool](tools/llama_index_retrieval/index.md) - Grounding an
  agent in a LlamaIndex.TS index you already built, without adding the
  dependency to ADK.
- [MCP tool error handling](tools/mcp_tool/error_handling/index.md) - Turning a
  failed MCP tool call into a result the model can read, and the MCP-App
  metadata accessors.
- [Tool response scheduling](tools/response_scheduling/index.md) - Controlling
  when the model reacts to a tool result on a Live API session.

### Utils

- [content_utils](utils/content_utils/index.md) - Reading and reshaping a genai
  `Content`: its text, its audio parts, and coercing a value into a user turn.

### Workflow

- [Workflow nodes](workflow/node/index.md) - Building a node from a function,
  tool, agent or node, subclassing `WorkflowNode`, and running a node once per
  item of a list input.
