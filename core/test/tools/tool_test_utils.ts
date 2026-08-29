/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, LlmRequest} from '@google/adk';
import {GenerateContentConfig} from '@google/genai';

/** An `LlmRequest` whose `config` is guaranteed present, so tests can index it. */
export type LlmRequestWithConfig = LlmRequest & {config: GenerateContentConfig};

export function makeLlmRequest(
  model = 'gemini-2.0-flash',
): LlmRequestWithConfig {
  return {
    model,
    config: {},
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

/**
 * A stand-in context for a tool that never reads one.
 *
 * `ToolProcessLlmRequest.toolContext` is required, and `processLlmRequest`
 * only touches `llmRequest`. Building a real `Context` needs an
 * `InvocationContext`, and so a session, an agent and the services behind
 * them, none of which the tool under test reaches.
 */
export function makeToolContext(): Context {
  return {} as Context;
}
