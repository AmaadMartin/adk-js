/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Giving an agent a working directory it can write, read and run code in.
 *
 * `EnvironmentToolset` exposes `Execute`, `ReadFile`, `EditFile` and
 * `WriteFile` over a `BaseEnvironment`. `LocalEnvironment` runs them in a
 * temporary directory on this host.
 *
 * `Execute` runs a shell command with no sandbox, so it asks for a
 * confirmation before it runs. Approve the call when the CLI prompts you.
 *
 * Run (makes real API calls, and runs commands on this machine):
 *   export GOOGLE_API_KEY=<your key>
 *   npm run sample -- samples/tools/environment_toolset/agent.ts
 *
 * Then ask: "write hello.py printing hello, read it back, then run it".
 */

import {EnvironmentToolset, LlmAgent, LocalEnvironment} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'environment_toolset_agent',
  model: 'gemini-2.5-flash',
  description: 'Writes, reads and runs code in a working directory.',
  instruction:
    'Use WriteFile to create a file, ReadFile to check its contents, and ' +
    'Execute to run it. Report the command output back to the user.',
  tools: [new EnvironmentToolset({environment: new LocalEnvironment()})],
});
