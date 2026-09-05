/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Save uploaded files as artifacts
 *
 * `SaveFilesAsArtifactsPlugin` takes every file the user attaches to a message,
 * stores it in the artifact service, and leaves a placeholder in its place. The
 * bytes stay out of the conversation history, and the agent reads the file back
 * through the `LOAD_ARTIFACTS` tool.
 *
 * A blob over 20 MB is rejected with an error part instead of being saved.
 *
 * Run:
 *   npm run sample -- samples/plugins/save_files_as_artifacts/agent.ts
 * Then attach a file to your message. A text-only turn does nothing.
 */

import {
  App,
  LlmAgent,
  LOAD_ARTIFACTS,
  SaveFilesAsArtifactsPlugin,
} from '@google/adk';

const agent = new LlmAgent({
  name: 'file_reader',
  model: 'gemini-2.5-flash',
  instruction:
    'Answer questions about the files the user uploads. Call load_artifacts' +
    ' with the artifact name shown in the placeholder to read one.',
  tools: [LOAD_ARTIFACTS],
});

export const app = new App({
  name: 'save_files_as_artifacts',
  rootAgent: agent,
  plugins: [new SaveFilesAsArtifactsPlugin()],
});
