/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ExecuteTool: run a shell command in an environment
 *
 * `ExecuteTool` gives an agent one tool, `Execute`, that runs a shell command
 * in a `BaseEnvironment` working directory and returns the exit code, stdout
 * and stderr.
 *
 * WARNING: `LocalEnvironment` runs the command on THIS machine with no
 * sandboxing. Every call therefore pauses for your confirmation first, and the
 * agent only runs the command after you approve it. There is no way to switch
 * that gate off.
 *
 * The environment must be initialized before the tool uses it. `ExecuteTool`
 * does not do this for you, and a command run against an uninitialized
 * environment comes back as `{status: 'error'}`.
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
