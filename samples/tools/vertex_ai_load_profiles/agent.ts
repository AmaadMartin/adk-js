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
 * profiles.
 *
 * This sample injects a fixed service so that it runs without a provisioned
 * Agent Engine. One of its two profiles carries no payload, and the tool drops
 * it. Swap in any service that implements `ProfileRetrievingMemoryService` to
 * read real profiles from Vertex AI Memory Bank.
 *
 * Run (calls the model):
 *   export GOOGLE_API_KEY=<your api key>
 *   npm run sample -- samples/tools/vertex_ai_load_profiles/agent.ts
 *
 * Ask: "What do you know about me?"
 */

import {
  LlmAgent,
  ProfileRetrievingMemoryService,
  VertexAiLoadProfilesTool,
} from '@google/adk';

class FixedProfiles implements ProfileRetrievingMemoryService {
  async retrieveProfiles(request: {appName: string; userId: string}) {
    return [
      {
        schemaId: 'user-profile',
        profile: {name: 'Kim', tone: 'concise', userId: request.userId},
      },
      {schemaId: 'purchase-history', profile: {}},
    ];
  }
}

export const rootAgent = new LlmAgent({
  name: 'vertex_ai_load_profiles_agent',
  model: 'gemini-2.5-flash',
  description: 'Answers using the profiles stored for the current user.',
  instruction:
    'Call load_profiles before you answer anything about the user. Answer ' +
    'in the tone the profile asks for.',
  tools: [new VertexAiLoadProfilesTool({memoryService: new FixedProfiles()})],
});
