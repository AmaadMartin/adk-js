/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ExecuteTool: run a shell command in an environment
 * See docs/guides/tools/execute_tool/index.md.
 *
 * WARNING: `LocalEnvironment` runs the command on THIS machine with no
 * sandboxing. Every call pauses for your confirmation first.
 *
 * Run:
 *   npm run sample -- samples/tools/environment_execute/agent.ts
 */

import {ExecuteTool, LlmAgent, LocalEnvironment} from '@google/adk';

const environment = new LocalEnvironment();
await environment.initialize();

export const rootAgent = new LlmAgent({
  name: 'root_agent',
  model: 'gemini-2.5-flash',
  instruction:
    'You run shell commands for the user with the Execute tool. Report the ' +
    'exit code and the output you get back.',
  tools: [new ExecuteTool(environment)],
});
