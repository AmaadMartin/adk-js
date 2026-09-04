/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Record every invocation to a debug file
 *
 * `DebugLoggingPlugin` writes one YAML document per invocation: the LLM
 * requests and responses, the tool calls and their results, the events, and
 * the session state at the end. Credentials are redacted, so the file can be
 * attached to a bug report.
 *
 * Run:
 *   npm run sample -- samples/plugins/debug_logging/agent.ts
 *
 * Ask about a city, then open the file the agent prints. Each turn appends
 * another `---` document, so the whole file loads with a multi-document YAML
 * loader.
 */

import {App, DebugLoggingPlugin, FunctionTool, LlmAgent} from '@google/adk';
import * as os from 'node:os';
import * as path from 'node:path';
import {z} from 'zod';

const outputPath = path.join(os.tmpdir(), 'adk_debug.yaml');

const lookupCity = new FunctionTool({
  name: 'lookup_city',
  description: 'Returns the population of a city.',
  parameters: z.object({city: z.string()}),
  execute: async ({city}) => ({city, population: 8_000_000}),
});

const agent = new LlmAgent({
  name: 'debug_logging_agent',
  model: 'gemini-2.5-flash',
  instruction:
    'Answer questions about cities. Call lookup_city for a population,' +
    ` then tell the user their debug trace is at ${outputPath}.`,
  tools: [lookupCity],
});

export const app = new App({
  name: 'debug_logging',
  rootAgent: agent,
  plugins: [new DebugLoggingPlugin({outputPath})],
});
