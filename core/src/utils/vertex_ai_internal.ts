/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deep imports for the `@google-cloud/vertexai` Agent Engine symbols missing
 * from its root entry point: v1.12.0 ships no `exports` map, and `main`
 * re-exports only `Client`, `VertexAI`, `./types` and `./models`. Confining
 * the `build/src/**` specifiers here gives that upstream gap a single blast
 * radius; delete this module and repoint its consumers once the package
 * root-exports the `genai` surface. `Client` is root-exported already and does
 * not belong here.
 *
 * A symbol keeps its upstream name unless that name is ambiguous with another
 * type in scope at a use site, in which case it takes a `VertexAi` prefix:
 * `Session`, `SessionEvent` and `EventMetadata` against ADK's own `Session`
 * and `Event`, and `Language` against the same-named `@google/genai` enum,
 * whose Python member is `PYTHON` rather than `LANGUAGE_PYTHON`.
 *
 * `Language` is a runtime enum, so it must stay a value re-export; as
 * `export type` it still compiles but resolves to `undefined` at run time.
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
