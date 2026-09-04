/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Grounding an agent on a Vertex AI Search data store.
 *
 * `DiscoveryEngineSearchTool` runs the search itself, so any model can use it.
 *
 * Run (makes real API calls):
 *   export DISCOVERY_ENGINE_DATA_STORE_ID=projects/<project>/locations/global/collections/default_collection/dataStores/<store>
 *   gcloud auth application-default login
 *   npm run sample -- samples/tools/discovery_engine_search/agent.ts
 */

import {DiscoveryEngineSearchTool, LlmAgent} from '@google/adk';

const dataStoreId = process.env['DISCOVERY_ENGINE_DATA_STORE_ID'];
if (!dataStoreId) {
  throw new Error('Set DISCOVERY_ENGINE_DATA_STORE_ID to a data store id.');
}

export const rootAgent = new LlmAgent({
  name: 'discovery_engine_search_agent',
  model: 'gemini-2.5-flash',
  description: 'Answers questions from a Vertex AI Search data store.',
  instruction:
    'Answer the question using discovery_engine_search. Cite the url of ' +
    'every result you use.',
  tools: [new DiscoveryEngineSearchTool({dataStoreId})],
});
