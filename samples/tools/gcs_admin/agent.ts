/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Administering Cloud Storage buckets from an agent.
 *
 * `GcsAdminToolset` is read-only by default, so this agent can describe the
 * project's buckets but cannot create, change or delete one. Pass
 * `gcsToolSettings: {capabilities: [GcsCapabilities.READ_WRITE]}` to add the
 * three write tools; each of those asks the user to confirm before it runs.
 *
 * Run (makes real API calls, and lists real buckets):
 *   npm install @google-cloud/storage
 *   export GOOGLE_CLOUD_PROJECT=<your project id>
 *   gcloud auth application-default login
 *   npm run sample -- samples/tools/gcs_admin/agent.ts
 *
 * Then ask: "which buckets are in my project?"
 */

import {GcsAdminToolset, LlmAgent} from '@google/adk';

const projectId = process.env['GOOGLE_CLOUD_PROJECT'];
if (!projectId) {
  throw new Error('Set GOOGLE_CLOUD_PROJECT to the project id to inspect.');
}

export const rootAgent = new LlmAgent({
  name: 'gcs_admin_agent',
  model: 'gemini-2.5-flash',
  description: "Answers questions about a project's Cloud Storage buckets.",
  instruction:
    `Answer questions about the Cloud Storage buckets in project ${projectId}. ` +
    'Pass that project id to every tool that asks for one. Report what the ' +
    'tools return; do not guess a bucket name.',
  tools: [
    new GcsAdminToolset({
      credentialsConfig: {applicationDefaultCredentials: true},
    }),
  ],
});
