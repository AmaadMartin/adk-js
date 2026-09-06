/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ToolErrorType,
  ToolExecutionError,
} from '../errors/tool_execution_error.js';
import {
  BaseExampleProvider,
  isBaseExampleProvider,
} from '../examples/base_example_provider.js';
import {Example, isExampleArray} from '../examples/example.js';
import {buildExampleSi} from '../examples/example_util.js';
import {appendInstructions} from '../models/llm_request.js';
import {resolveFullyQualifiedName} from '../utils/module_utils.js';

import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';

/**
 * The declarative configuration of an {@link ExampleTool}, as an agent config
 * file supplies it.
 *
 * It differs from the constructor argument because a config file cannot hold a
 * provider object. It names one instead.
 */
export interface ExampleToolConfig {
  /**
   * The few-shot examples themselves, or a fully-qualified name of the form
   * `<module specifier>#<export>` that resolves to a
   * {@link BaseExampleProvider} exported by user code.
   */
  examples: Example[] | string;
}

/**
 * A tool that adds (few-shot) examples to the LLM request.
 *
 * This tool is executed for each LLM request and is never called by the model;
 * it only mutates the outgoing request by appending few-shot instructions built
 * from the latest user query.
 */
export class ExampleTool extends BaseTool {
  constructor(readonly examples: Example[] | BaseExampleProvider) {
    super({
      // Name and description are not used because this tool only changes
      // llmRequest.
      name: 'example_tool',
      description: 'example tool',
    });
  }

  /**
   * Builds a tool from its declarative configuration.
   *
   * @param config The tool configuration read from an agent config file.
   * @param configAbsPath Absolute path of that config file. A relative module
   *   specifier in `config.examples` resolves against its directory.
   * @return The configured tool.
   * @throws {ToolExecutionError} When `examples` names a value that is not a
   *   {@link BaseExampleProvider}, or is neither a name nor a list of
   *   examples.
   * @throws {InputValidationError} When `examples` is a name that does not
   *   resolve.
   */
  static async fromConfig(
    config: ExampleToolConfig,
    configAbsPath: string,
  ): Promise<ExampleTool> {
    const {examples} = config;
    if (typeof examples === 'string') {
      const provider = await resolveFullyQualifiedName(examples, configAbsPath);
      if (!isBaseExampleProvider(provider)) {
        throw new ToolExecutionError(
          'Example provider must be an instance of BaseExampleProvider.',
          ToolErrorType.BAD_REQUEST,
        );
      }
      return new ExampleTool(provider);
    }
    if (isExampleArray(examples)) {
      return new ExampleTool(examples);
    }
    throw new ToolExecutionError(
      'Example tool config must be a list of examples or a fully-qualified ' +
        'name to a BaseExampleProvider object in code.',
      ToolErrorType.BAD_REQUEST,
    );
  }

  override async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    // Should not be called by model because it's not declared in LLM tools list.
    throw new Error('ExampleTool should not be called by model');
  }

  override async processLlmRequest({
    toolContext,
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    const parts = toolContext.userContent?.parts;
    if (!parts || !parts[0]?.text) {
      return;
    }
    appendInstructions(llmRequest, [
      buildExampleSi(this.examples, parts[0].text, llmRequest.model),
    ]);
  }
}
