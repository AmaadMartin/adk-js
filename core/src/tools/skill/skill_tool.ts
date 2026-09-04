/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../../utils/experimental.js';
import {BaseTool, BaseToolParams, ToolProcessLlmRequest} from '../base_tool.js';
import {SkillToolset} from './skill_toolset.js';

/**
 * A tool that belongs to a {@link SkillToolset}.
 *
 * `LlmAgent` flattens a toolset into its tools and then calls
 * `processLlmRequest` on each tool, never on the toolset. Each skill tool
 * therefore hands the request to its toolset, which brings the environment up
 * and writes the skill guidance the first time it sees that request.
 */
@experimental
export abstract class SkillTool extends BaseTool {
  constructor(
    protected readonly toolset: SkillToolset,
    params: BaseToolParams,
  ) {
    super(params);
  }

  override async processLlmRequest(
    request: ToolProcessLlmRequest,
  ): Promise<void> {
    await super.processLlmRequest(request);
    await this.toolset.prepareLlmRequest(
      request.toolContext,
      request.llmRequest,
    );
  }
}
