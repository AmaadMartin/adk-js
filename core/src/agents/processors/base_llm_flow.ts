/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
} from './base_llm_processor.js';

/**
 * The two processor lists a flow is built from, in the order they run. A
 * subclass calls `super()` and then appends to them, which is how adk-python's
 * `SingleFlow` and `AutoFlow` compose. adk-python's `BaseLlmFlow` also owns the
 * loop that runs the processors; adk-js keeps that loop in `LlmAgent`.
 */
export abstract class BaseLlmFlow {
  readonly requestProcessors: BaseLlmRequestProcessor[] = [];
  readonly responseProcessors: BaseLlmResponseProcessor[] = [];
}
