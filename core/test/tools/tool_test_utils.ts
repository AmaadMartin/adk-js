/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, LlmRequest} from '@google/adk';
import {GenerateContentConfig} from '@google/genai';

/** An `LlmRequest` whose `config` is guaranteed present, so tests can index it. */
export type LlmRequestWithConfig = LlmRequest & {config: GenerateContentConfig};

export function makeLlmRequest(): LlmRequestWithConfig {
  return {
    model: 'gemini-2.0-flash',
    config: {},
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };
}

/** An empty `Context` stand-in, for tools that never read the context. */
export function makeToolContext(): Context {
  return {} as Context;
}
