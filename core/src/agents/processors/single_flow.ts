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
import {CONTEXT_CACHE_REQUEST_PROCESSOR} from './context_cache_request_processor.js';
import {ContextCompactorRequestProcessor} from './context_compactor_request_processor.js';
import {IDENTITY_LLM_REQUEST_PROCESSOR} from './identity_llm_request_processor.js';
import {INSTRUCTIONS_LLM_REQUEST_PROCESSOR} from './instructions_llm_request_processor.js';
import {INTERACTIONS_REQUEST_PROCESSOR} from './interactions_request_processor.js';
import {
  NL_PLANNING_REQUEST_PROCESSOR,
  NL_PLANNING_RESPONSE_PROCESSOR,
} from './nl_planning_processor.js';
import {OUTPUT_SCHEMA_REQUEST_PROCESSOR} from './output_schema_request_processor.js';
import {REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR} from './request_confirmation_llm_request_processor.js';
import {REQUEST_INPUT_LLM_REQUEST_PROCESSOR} from './request_input_llm_request_processor.js';
import {TOOL_FILTER_REQUEST_PROCESSOR} from './tool_filter_request_processor.js';

/**
 * The standard processor pipeline for an agent that considers only itself and
 * its tools. A single flow permits no transfer to another agent.
 *
 * Sub-agent transfer is not part of it. `AutoFlow` appends the agent-transfer
 * processor for an agent that can transfer, and `LlmAgent` appends it to a
 * caller-supplied pipeline. A subclass adds its own processors by pushing onto
 * the lists {@link BaseLlmFlow} gives it, as adk-python's `AutoFlow` does. Both
 * lists are fresh arrays, so a caller that appends to them affects no other
 * agent.
 *
 * The order of {@link requestProcessors} is part of the contract. Code
 * execution reads the contents that {@link CONTENT_REQUEST_PROCESSOR}
 * assembles, and compaction rewrites the history those contents come from, so
 * it runs immediately before them.
 */
export class SingleFlow extends BaseLlmFlow {
  /**
   * @param contextCompactors - Compactors to evaluate before the contents are
   *   assembled. The compaction processor is always inserted, because an agent
   *   that declares no compactors still honours the compaction policy its App
   *   declares, and that policy only arrives per invocation. With neither, the
   *   processor does nothing.
   */
  constructor(contextCompactors: BaseContextCompactor[] = []) {
    super();
    this.requestProcessors.push(
      BASIC_LLM_REQUEST_PROCESSOR,
      AUTH_PREPROCESSOR,
      REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR,
      REQUEST_INPUT_LLM_REQUEST_PROCESSOR,
      // The agent's own instruction comes before the identity preamble, so the
      // two SDKs assemble the same system instruction from one agent.
      INSTRUCTIONS_LLM_REQUEST_PROCESSOR,
      IDENTITY_LLM_REQUEST_PROCESSOR,
      // Read the Interactions chain id before contents. A chained request
      // needs only the current turn, because the service keeps the earlier
      // turns.
      INTERACTIONS_REQUEST_PROCESSOR,
      // Compaction runs before contents so the compacted events reach the
      // model.
      new ContextCompactorRequestProcessor(contextCompactors),
      CONTENT_REQUEST_PROCESSOR,
      // Context caching reads the contents the previous processor assembled.
      CONTEXT_CACHE_REQUEST_PROCESSOR,
      // NL planning runs after contents so the previous turn's thought marks
      // can be cleared, and before code execution.
      NL_PLANNING_REQUEST_PROCESSOR,
      // Code execution runs after contents because it rewrites the contents to
      // optimize data files.
      CODE_EXECUTION_REQUEST_PROCESSOR,
      // The output schema workaround declares a tool, so it runs after the
      // processors that shape the contents. It is the last processor that
      // appends a system instruction, so its instruction lands at the end of
      // the system prompt. The tool filter that follows appends none.
      OUTPUT_SCHEMA_REQUEST_PROCESSOR,
      TOOL_FILTER_REQUEST_PROCESSOR,
    );
    this.responseProcessors.push(
      NL_PLANNING_RESPONSE_PROCESSOR,
      CODE_EXECUTION_RESPONSE_PROCESSOR,
    );
  }
}
