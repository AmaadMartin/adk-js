/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cloud Storage bucket administration
 *
 * An agent that inspects Cloud Storage buckets with `GcsAdminToolset`. It is
 * read-only: it can describe a bucket and list the buckets in a project, and
 * it cannot create, change or delete one. See the README next to this file
 * for how to make it read-write.
 *
 * REQUIRES a model API key and Google Cloud credentials. Set GEMINI_API_KEY,
 * run `gcloud auth application-default login`, then:
 *   npm run sample -- samples/tools/gcs_admin/agent.ts
 */

import {GcsAdminToolset, GcsCredentialsConfig, LlmAgent} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';

// Application default credentials, the recommended way to run this locally.
// For an interactive OAuth flow instead, build the config from the OAuth2
// client id and secret; the README shows both.
const credentials = await new GoogleAuth().getClient();

export const rootAgent = new LlmAgent({
  name: 'gcs_admin_agent',
  model: 'gemini-flash-latest',
  description: 'Answers questions about Cloud Storage buckets.',
  instruction: `You help the user inspect their Cloud Storage buckets.

    Use gcs_list_buckets to list the buckets in a project, and gcs_get_bucket
    to describe one. Ask the user for the project id if they have not given
    one. Report a tool error back to the user in plain language.`,
  tools: [
    new GcsAdminToolset({
      credentialsConfig: new GcsCredentialsConfig({credentials}),
    }),
  ],
});
