/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AUTH_PREPROCESSOR} from '../../auth/auth_preprocessor.js';
import {BaseContextCompactor} from '../../context/base_context_compactor.js';
import {BaseLlmFlow} from './base_llm_flow.js';
import {BASIC_LLM_REQUEST_PROCESSOR} from './basic_llm_request_processor.js';
import {
  CODE_EXECUTION_REQUEST_PROCESSOR,
  responseProcessor as CODE_EXECUTION_RESPONSE_PROCESSOR,
} from './code_execution_request_processor.js';
import {CONTENT_REQUEST_PROCESSOR} from './content_request_processor.js';
import {ContextCompactorRequestProcessor} from './context_compactor_request_processor.js';
import {IDENTITY_LLM_REQUEST_PROCESSOR} from './identity_llm_request_processor.js';
import {INSTRUCTIONS_LLM_REQUEST_PROCESSOR} from './instructions_llm_request_processor.js';
import {INTERACTIONS_REQUEST_PROCESSOR} from './interactions_request_processor.js';
import {OUTPUT_SCHEMA_REQUEST_PROCESSOR} from './output_schema_request_processor.js';
import {REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR} from './request_confirmation_llm_request_processor.js';
import {REQUEST_INPUT_LLM_REQUEST_PROCESSOR} from './request_input_llm_request_processor.js';
import {TOOL_FILTER_REQUEST_PROCESSOR} from './tool_filter_request_processor.js';

/**
 * The standard processor pipeline for an agent that considers only itself and
 * its tools.
 *
 * Sub-agent transfer is not part of it. `LlmAgent` appends the agent-transfer
 * processor separately when the agent can transfer. A subclass adds its own
 * processors by pushing onto the lists it inherits, as adk-python's `AutoFlow`
 * does.
 */
export class SingleFlow extends BaseLlmFlow {
  /**
   * @param contextCompactors - Compactors to evaluate before the conversation
   *   history is assembled. When empty, no compaction processor is inserted.
   */
  constructor(contextCompactors: BaseContextCompactor[] = []) {
    super();
    this.requestProcessors.push(
      BASIC_LLM_REQUEST_PROCESSOR,
      AUTH_PREPROCESSOR,
      INSTRUCTIONS_LLM_REQUEST_PROCESSOR,
      IDENTITY_LLM_REQUEST_PROCESSOR,
      REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR,
      REQUEST_INPUT_LLM_REQUEST_PROCESSOR,
      // Read the Interactions chain id before contents. A chained request
      // needs only the current turn, because the service keeps the earlier
      // turns.
      INTERACTIONS_REQUEST_PROCESSOR,
      // Compaction runs before contents so the compacted events reach the
      // model.
      ...(contextCompactors.length > 0
        ? [new ContextCompactorRequestProcessor(contextCompactors)]
        : []),
      CONTENT_REQUEST_PROCESSOR,
      // Code execution runs after contents because it rewrites the contents to
      // optimize data files.
      CODE_EXECUTION_REQUEST_PROCESSOR,
      TOOL_FILTER_REQUEST_PROCESSOR,
      // Last, so its instruction lands at the end of the system prompt.
      OUTPUT_SCHEMA_REQUEST_PROCESSOR,
    );
    this.responseProcessors.push(CODE_EXECUTION_RESPONSE_PROCESSOR);
  }
}
