/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AUTH_PREPROCESSOR} from '../../auth/auth_preprocessor.js';
import {BaseContextCompactor} from '../../context/base_context_compactor.js';
import {
  BaseLlmRequestProcessor,
  BaseLlmResponseProcessor,
} from './base_llm_processor.js';
import {BASIC_LLM_REQUEST_PROCESSOR} from './basic_llm_request_processor.js';
import {CODE_EXECUTION_REQUEST_PROCESSOR} from './code_execution_request_processor.js';
import {CONTENT_REQUEST_PROCESSOR} from './content_request_processor.js';
import {ContextCompactorRequestProcessor} from './context_compactor_request_processor.js';
import {IDENTITY_LLM_REQUEST_PROCESSOR} from './identity_llm_request_processor.js';
import {INSTRUCTIONS_LLM_REQUEST_PROCESSOR} from './instructions_llm_request_processor.js';
import {INTERACTIONS_REQUEST_PROCESSOR} from './interactions_request_processor.js';
import {REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR} from './request_confirmation_llm_request_processor.js';
import {REQUEST_INPUT_LLM_REQUEST_PROCESSOR} from './request_input_llm_request_processor.js';
import {TOOL_FILTER_REQUEST_PROCESSOR} from './tool_filter_request_processor.js';

/**
 * The processor pipeline for an agent that considers only itself and its
 * tools. A single flow permits no transfer to another agent.
 *
 * The order of {@link requestProcessors} is part of the contract. Code
 * execution reads the contents that {@link CONTENT_REQUEST_PROCESSOR}
 * assembles, and compaction rewrites the history those contents come from, so
 * it runs immediately before them.
 */
export class SingleFlow {
  /** The request processors, in the order they run. */
  readonly requestProcessors: BaseLlmRequestProcessor[];

  /** The response processors, in the order they run. */
  readonly responseProcessors: BaseLlmResponseProcessor[];

  /**
   * @param contextCompactors - Compactors to evaluate before the contents are
   *   assembled. When empty, no compaction processor is inserted.
   */
  constructor(contextCompactors: BaseContextCompactor[] = []) {
    this.requestProcessors = [
      BASIC_LLM_REQUEST_PROCESSOR,
      AUTH_PREPROCESSOR,
      IDENTITY_LLM_REQUEST_PROCESSOR,
      INSTRUCTIONS_LLM_REQUEST_PROCESSOR,
      REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR,
      REQUEST_INPUT_LLM_REQUEST_PROCESSOR,
      ...(contextCompactors.length > 0
        ? [new ContextCompactorRequestProcessor(contextCompactors)]
        : []),
      CONTENT_REQUEST_PROCESSOR,
      INTERACTIONS_REQUEST_PROCESSOR,
      CODE_EXECUTION_REQUEST_PROCESSOR,
      TOOL_FILTER_REQUEST_PROCESSOR,
    ];
    this.responseProcessors = [];
  }
}
