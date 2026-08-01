/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Canonical placeholder GCP project id for Vertex AI tests. */
export const TEST_PROJECT_ID = 'test-project';

/**
 * Canonical placeholder location for Vertex AI tests.
 *
 * Matches the default `AgentEngineSandboxCodeExecutor` falls back to when no
 * location is configured, so mocked resource names line up with the ones the
 * executor builds itself.
 */
export const TEST_LOCATION = 'us-central1';

/**
 * Canonical placeholder Agent Engine (reasoning engine) id.
 *
 * Must stay all-digits: `VertexAiSessionService` only accepts a numeric engine
 * id, either bare or as the trailing segment of a full resource name.
 */
export const TEST_AGENT_ENGINE_ID = '12345';

/** Options for {@link buildAgentEngineAppName}. */
export interface AgentEngineAppNameOptions {
  projectId: string;
  location: string;
  agentEngineId: string;
}

/**
 * Builds a fully qualified Agent Engine resource name, the form
 * `VertexAiSessionService` accepts as an `appName`.
 */
export function buildAgentEngineAppName({
  projectId,
  location,
  agentEngineId,
}: AgentEngineAppNameOptions): string {
  return `projects/${projectId}/locations/${location}/reasoningEngines/${agentEngineId}`;
}

/** {@link buildAgentEngineAppName} applied to the canonical placeholders. */
export const TEST_AGENT_ENGINE_APP_NAME = buildAgentEngineAppName({
  projectId: TEST_PROJECT_ID,
  location: TEST_LOCATION,
  agentEngineId: TEST_AGENT_ENGINE_ID,
});
