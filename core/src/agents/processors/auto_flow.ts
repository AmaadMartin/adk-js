/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseContextCompactor} from '../../context/base_context_compactor.js';
import {AGENT_TRANSFER_LLM_REQUEST_PROCESSOR} from './agent_transfer_llm_request_processor.js';
import {SingleFlow} from './single_flow.js';

/**
 * {@link SingleFlow} with agent transfer capability.
 *
 * Transfer runs in three directions: from a parent to one of its sub-agents,
 * from a sub-agent back to its parent, and from a sub-agent to one of its
 * peers. The peer case applies only when the parent is itself an `LlmAgent`
 * and `disallowTransferToPeers` is false.
 *
 * A transfer may be reversed automatically, depending on the target agent
 * type. The runner decides which agent stays active for the next user message.
 */
export class AutoFlow extends SingleFlow {
  constructor(contextCompactors: BaseContextCompactor[] = []) {
    super(contextCompactors);
    this.requestProcessors.push(AGENT_TRANSFER_LLM_REQUEST_PROCESSOR);
  }
}
