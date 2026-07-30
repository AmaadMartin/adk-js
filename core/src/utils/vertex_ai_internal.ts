/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The single choke point for `@google-cloud/vertexai` symbols that the package
 * does not expose from its root entry point.
 *
 * As of `@google-cloud/vertexai@1.12.0` the published package declares no
 * `exports` map and only `main: build/src/index.js`, and that entry point
 * re-exports just `Client`, `VertexAI`, `./types` and `./models`. The Agent
 * Engine surface under `build/src/genai/**` — the `Sessions` and `Memories`
 * modules and every symbol in `genai/types.js` — is therefore reachable only
 * through a compiled build-output path, which upstream is free to reorganise
 * in any release.
 *
 * Keeping every such specifier in this one module bounds the blast radius of
 * that upstream gap to a single file. `Client` is root-exported and must be
 * imported from `'@google-cloud/vertexai'` directly — it does not belong here.
 * When the package ships an `exports` map, or re-exports the `genai` surface
 * from its root entry point, delete this module and repoint its consumers.
 *
 * `Language` is a runtime enum and must stay a value re-export; everything
 * else is only ever used in type position here, so `export type` keeps the
 * extra CommonJS modules out of the runtime graph.
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
