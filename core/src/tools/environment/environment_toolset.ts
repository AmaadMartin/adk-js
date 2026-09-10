/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {BaseEnvironment} from '../../environment/base_environment.js';
import {appendInstructions, LlmRequest} from '../../models/llm_request.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {environmentInstruction} from './constants.js';
import {EditFileTool} from './edit_file_tool.js';
import {ExecuteTool} from './execute_tool.js';
import {ReadFileTool} from './read_file_tool.js';
import {WriteFileTool} from './write_file_tool.js';

/** Options for {@link EnvironmentToolset}. */
export interface EnvironmentToolsetOptions {
  /** The environment used to execute commands and perform file I/O. */
  environment: BaseEnvironment;
  /** Character cap for stdout, stderr and file-content truncation. */
  maxOutputChars?: number;
  /** Forwarded to `BaseToolset`. */
  toolFilter?: ToolPredicate | string[];
  /** Forwarded to `BaseToolset`. */
  prefix?: string;
}

/**
 * Toolset providing tools to interact with an environment.
 *
 * Tools provided:
 * - **Execute** — run shell commands
 * - **ReadFile** — read file contents
 * - **EditFile** — surgical text replacement
 * - **WriteFile** — create or overwrite files
 *
 * The toolset injects an environment-level system instruction on each LLM call
 * that establishes the working directory and the tool selection rules.
 *
 * `Execute` runs the command on whatever host the environment reaches, so it is
 * gated behind an explicit tool confirmation. The file tools are not gated: the
 * environment owns its own path boundary.
 */
@experimental
export class EnvironmentToolset extends BaseToolset {
  private readonly environment: BaseEnvironment;
  private readonly maxOutputChars?: number;
  private environmentInitialized = false;

  constructor(options: EnvironmentToolsetOptions) {
    super(options.toolFilter ?? [], options.prefix);
    this.environment = options.environment;
    this.maxOutputChars = options.maxOutputChars;
  }

  override async getTools(): Promise<BaseTool[]> {
    await this.initializeEnvironment();
    return [
      new ExecuteTool(this.environment, {maxOutputChars: this.maxOutputChars}),
      new ReadFileTool(this.environment, {maxOutputChars: this.maxOutputChars}),
      new EditFileTool(this.environment),
      new WriteFileTool(this.environment),
    ];
  }

  override async processLlmRequest(
    _toolContext: Context,
    llmRequest: LlmRequest,
  ): Promise<void> {
    await this.initializeEnvironment();
    appendInstructions(llmRequest, [
      environmentInstruction(this.environment.workingDir),
    ]);
  }

  override async close(): Promise<void> {
    if (this.environmentInitialized) {
      await this.environment.close();
      this.environmentInitialized = false;
    }
  }

  /**
   * Initializes the environment once.
   *
   * The flag lives here rather than on `environment.isInitialized`, because the
   * base `initialize()` is a no-op that leaves that flag `false`. A subclass
   * that does not set it would be re-initialised on every call.
   */
  private async initializeEnvironment(): Promise<void> {
    if (!this.environmentInitialized) {
      await this.environment.initialize();
      this.environmentInitialized = true;
    }
  }
}
