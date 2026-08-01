/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deep imports for the `@google-cloud/vertexai` Agent Engine symbols missing
 * from its root entry point: v1.12.0 ships no `exports` map and `main`
 * re-exports only `Client`, `VertexAI`, `./types` and `./models`. Confining
 * the `build/src/**` specifiers here keeps the upstream gap in one place for
 * `core`; delete this module once the package root-exports the `genai`
 * surface. (`dev` still deep-imports: it consumes `@google/adk` as a package,
 * whose `exports` map publishes only `'.'`, so it cannot reach this module.)
 *
 * `VertexAi`-prefixed names disambiguate against ADK's own `Session` and
 * `Event`, and against `@google/genai`'s `Language`, whose Python member is
 * `PYTHON` rather than `LANGUAGE_PYTHON`. `Language` is also the one runtime
 * enum here, so it must stay a value re-export.
 */

export type {Memories} from '@google-cloud/vertexai/build/src/genai/memories.js';
export type {Sessions} from '@google-cloud/vertexai/build/src/genai/sessions.js';
export {Language as VertexAiLanguage} from '@google-cloud/vertexai/build/src/genai/types.js';
export type {
  AgentEngineMemoryConfig,
  AppendAgentEngineSessionEventConfig,
  AppendAgentEngineSessionEventRequestParameters,
  GenerateAgentEngineMemoriesConfig,
  GenerateMemoriesRequestDirectContentsSourceEvent,
  MemoryMetadataValue,
  EventMetadata as VertexAiEventMetadata,
  Session as VertexAiSession,
  SessionEvent as VertexAiSessionEvent,
} from '@google-cloud/vertexai/build/src/genai/types.js';
