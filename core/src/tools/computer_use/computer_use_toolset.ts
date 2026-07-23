/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */

import {Context} from '../../agents/context.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {LlmRequest} from '../../models/llm_request.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseToolset} from '../base_toolset.js';
import {BaseComputer} from './base_computer.js';
import {ComputerUseTool} from './computer_use_tool.js';

const EXCLUDED_METHODS = new Set([
  'screenSize',
  'environment',
  'close',
  'prepare',
  'initialize',
]);

@experimental
export class ComputerUseToolset extends BaseToolset {
  private readonly computer: BaseComputer;
  private readonly excludedPredefinedFunctions?: string[];
  private tools: ComputerUseTool[] | null = null;

  constructor(options: {
    computer: BaseComputer;
    excludedPredefinedFunctions?: string[];
  }) {
    super([]);
    this.computer = options.computer;
    this.excludedPredefinedFunctions = options.excludedPredefinedFunctions;
  }

  override async getTools(
    readonlyContext?: ReadonlyContext,
  ): Promise<ComputerUseTool[]> {
    if (this.tools) {
      return this.tools;
    }

    await this.computer.initialize();
    const screenSize = await this.computer.screenSize();

    this.tools = [];
    const methodNames = new Set<string>();

    let proto = Object.getPrototypeOf(this.computer);
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (
          name !== 'constructor' &&
          !name.startsWith('_') &&
          !EXCLUDED_METHODS.has(name) &&
          typeof (this.computer as any)[name] === 'function'
        ) {
          methodNames.add(name);
        }
      }
      proto = Object.getPrototypeOf(proto);
    }

    for (const methodName of methodNames) {
      const snakeCaseName = methodName.replace(
        /[A-Z]/g,
        (letter) => `_${letter.toLowerCase()}`,
      );

      if (
        this.excludedPredefinedFunctions &&
        (this.excludedPredefinedFunctions.includes(methodName) ||
          this.excludedPredefinedFunctions.includes(snakeCaseName))
      ) {
        continue;
      }

      const instanceMethod = (this.computer as any)[methodName].bind(
        this.computer,
      );

      const wrappedMethod = async (args: any, toolContext: Context) => {
        if (toolContext) {
          await this.computer.prepare(toolContext);
        }
        return await instanceMethod(args);
      };

      this.tools.push(
        new ComputerUseTool({
          name: snakeCaseName,
          func: wrappedMethod,
          screenSize,
        }),
      );
    }

    return this.tools;
  }

  override async close(): Promise<void> {
    await this.computer.close();
  }

  override async processLlmRequest(
    toolContext: Context,
    llmRequest: LlmRequest,
  ): Promise<void> {
    try {
      if (!this.tools) {
        await this.getTools();
      }

      for (const tool of this.tools!) {
        llmRequest.toolsDict[tool.name] = tool;
      }

      llmRequest.config = llmRequest.config || {};
      llmRequest.config.tools = llmRequest.config.tools || [];

      for (const tool of llmRequest.config.tools) {
        if ((tool as any).computerUse) {
          logger.debug('Computer use already configured in LLM request');
          return;
        }
      }

      const computerEnv = await this.computer.environment();

      llmRequest.config.tools.push({
        computerUse: {
          environment: computerEnv as any,
          excludedPredefinedFunctions: this.excludedPredefinedFunctions,
        },
      } as any);

      logger.debug(
        `Added computer use tool with environment: ${computerEnv}, excluded_functions: ${this.excludedPredefinedFunctions}`,
      );
    } catch (e) {
      logger.error(`Error in ComputerUseToolset.processLlmRequest: ${e}`);
      throw e;
    }
  }
}
