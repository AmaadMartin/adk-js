/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Administering Cloud Spanner from an agent.
 *
 * The toolset is filtered to the five read-only tools, because
 * `spanner_create_instance` and `spanner_create_database` provision billable
 * resources. Drop the `toolFilter` to let the agent create them.
 *
 * Run (makes real API calls):
 *   gcloud auth application-default login
 *   npm install @google-cloud/spanner
 *   npm run sample -- samples/tools/spanner_admin/agent.ts
 */

import {LlmAgent} from '@google/adk';
import {
  SPANNER_DEFAULT_SCOPES,
  SpannerAdminToolset,
} from '@google/adk/tools/spanner';
import {GoogleAuth} from 'google-auth-library';

const authClient = await new GoogleAuth({
  scopes: [...SPANNER_DEFAULT_SCOPES],
}).getClient();

export const rootAgent = new LlmAgent({
  name: 'spanner_admin_agent',
  model: 'gemini-2.5-flash',
  description: 'Inspects Cloud Spanner instances and databases.',
  instruction:
    'Answer questions about the Spanner instances and databases in the ' +
    "user's project. Ask which project to use if the user has not said.",
  tools: [
    new SpannerAdminToolset({
      credentialsConfig: {authClient},
      toolFilter: [
        'spanner_list_instances',
        'spanner_get_instance',
        'spanner_list_databases',
        'spanner_list_instance_configs',
        'spanner_get_instance_config',
      ],
    }),
  ],
});
