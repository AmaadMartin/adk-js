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
 * The construction contract of adk-python's `BaseLlmFlow`: the base class
 * supplies two empty processor lists, and a subclass appends to them from its
 * own constructor after it calls `super()`.
 *
 * adk-python's class also owns the loop that runs the processors and calls the
 * model. adk-js keeps that loop in `LlmAgent.runOneStepAsync`, so this class
 * carries the composition only.
 */
export abstract class BaseLlmFlow {
  /** The request processors, in the order they run. */
  readonly requestProcessors: BaseLlmRequestProcessor[] = [];

  /** The response processors, in the order they run. */
  readonly responseProcessors: BaseLlmResponseProcessor[] = [];
}
