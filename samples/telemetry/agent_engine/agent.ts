/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Engine telemetry
 *
 * A minimal agent for checking the Agent Engine telemetry paths by hand. The
 * paths only activate when `GOOGLE_CLOUD_AGENT_ENGINE_ID` is set; see the
 * README next to this file for how to drive them.
 *
 * Run:
 *   npm run sample -- samples/telemetry/agent_engine/agent.ts
 */

import {LlmAgent} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'telemetry_agent',
  model: 'gemini-2.5-flash',
  description: 'Answers a question, so a run produces spans and metrics.',
  instruction: 'Answer the user in one sentence.',
});
