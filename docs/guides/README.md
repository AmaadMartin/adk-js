# ADK Developer Guides

This directory contains specific developer guides for the ADK JavaScript and
TypeScript implementation. One guide per feature, mirroring adk-python's
`docs/guides/` layout, so the two SDKs document a feature in the same place. For
the official ADK documentation, visit [adk.dev](https://adk.dev/).

## Index

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
- [Session to eval format](evaluation/session_to_eval_format/index.md) - Turning
  a recorded session into eval-set turn records.
- [TrajectoryEvaluator](evaluation/trajectory_evaluator/index.md) - Scoring an
  agent's tool calls against a golden trajectory, and the `Evaluator` seam every
  metric sits behind.

### Events

- [Event and NodeInfo](events/event/index.md) - The event fields, the
  convenience construction options, and reading the emitting workflow node.

### Models

- [Anthropic Claude models](models/anthropic/index.md) - Driving an agent with
  Claude, through the Anthropic API or Vertex AI.
- [Configuring the Gemini model](models/gemini_config/index.md) - Choosing
  the endpoint, API version, client and retries, and handling an exhausted
  quota.
- [Live responses](models/live_responses/index.md) - Reading a Gemini Live run:
  which response field carries what, how grounding accumulates, and how Gemini
  3.x differs.

### Tools

- [adkToMcpToolType and geminiToJsonSchema](tools/mcp_conversion_utils/index.md) -
  Convert an ADK tool into an MCP tool descriptor so an MCP server can
  advertise it.
- [APIHubToolset](tools/apihub_toolset/index.md) - Building agent tools from an
  API Hub specification, and controlling when it is fetched.
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
