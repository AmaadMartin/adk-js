/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WriteFileTool: letting an agent author a file
 *
 * The agent holds a `LocalEnvironment` scoped to a temporary directory, and a
 * `WriteFileTool` that writes into it. Ask it to "write a haiku to poem.txt"
 * and it calls `WriteFile` with a path and the full file content.
 *
 * The environment creates its temporary directory on `initialize()` and prints
 * the path below, so you can inspect what the agent wrote.
 *
 * Run (needs GEMINI_API_KEY):
 *   npm run sample -- samples/tools/environment_write_file/agent.ts
 */

import {LlmAgent, LocalEnvironment, WriteFileTool} from '@google/adk';

const environment = new LocalEnvironment();
await environment.initialize();

export const rootAgent = new LlmAgent({
  name: 'file_writer',
  model: 'gemini-flash-latest',
  description: 'Writes files into a workspace on request.',
  instruction:
    `You write files into a workspace with the WriteFile tool. The workspace ` +
    `is at ${environment.workingDir}. Use paths relative to it. After a ` +
    `write, tell the user the path you wrote and what you put in it.`,
  tools: [new WriteFileTool(environment)],
});
