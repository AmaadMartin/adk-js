/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Letting the model read the current user's structured profiles.
 *
 * `VertexAiLoadProfilesTool` takes no arguments. It reads the app name and the
 * user id from the tool context, so the model cannot ask for another user's
 * profiles. The agent engine must have structured memory schemas configured,
 * and the schema id you configure there keys each returned profile.
 *
 * Run (makes real API calls):
 *   export GOOGLE_CLOUD_PROJECT=<your project>
 *   export GOOGLE_CLOUD_LOCATION=<your location>
 *   export AGENT_ENGINE_ID=<your agent engine id>
 *   gcloud auth application-default login
 *   npm run sample -- samples/tools/vertex_ai_load_profiles/agent.ts
 *
 * Ask: "What do you know about me?"
 */

import {
  LlmAgent,
  VertexAiLoadProfilesTool,
  VertexAiMemoryBankService,
} from '@google/adk';

const agentEngineId = process.env['AGENT_ENGINE_ID'];
if (!agentEngineId) {
  throw new Error('Set AGENT_ENGINE_ID to an agent engine id.');
}

const memoryService = new VertexAiMemoryBankService({
  projectId: process.env['GOOGLE_CLOUD_PROJECT'],
  location: process.env['GOOGLE_CLOUD_LOCATION'],
  agentEngineId,
});

export const rootAgent = new LlmAgent({
  name: 'vertex_ai_load_profiles_agent',
  model: 'gemini-2.5-flash',
  description: 'Answers using the profiles stored for the current user.',
  instruction:
    'Call load_profiles before you answer anything about the user. Answer ' +
    'in the tone the profile asks for.',
  tools: [new VertexAiLoadProfilesTool(memoryService)],
});
