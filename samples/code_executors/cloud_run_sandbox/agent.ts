/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CloudRunSandboxCodeExecutor
 *
 * The agent answers a question by writing code and running it inside the
 * Cloud Run container's own sandbox. The sandbox binary exists only in a
 * Cloud Run container that has sandboxes enabled; anywhere else every run
 * comes back with a "Sandbox binary ... not found" stderr.
 *
 * Run:
 *   npm run sample -- samples/code_executors/cloud_run_sandbox/agent.ts
 */

import {CloudRunSandboxCodeExecutor, LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'data_analyst',
  model: 'gemini-2.5-flash',
  instruction:
    'Write and run code to answer the question. Report the output you get.',
  // Egress is off, so the code cannot reach the network. Point `sandboxBin`
  // at a local stand-in script to try the plumbing outside Cloud Run.
  codeExecutor: new CloudRunSandboxCodeExecutor({
    sandboxBin: process.env['SANDBOX_BIN'],
    timeoutSeconds: 30,
  }),
});
