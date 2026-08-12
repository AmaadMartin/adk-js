/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseExampleProvider} from '../examples/base_example_provider.js';
import {Example} from '../examples/example.js';
import {buildExampleSi} from '../examples/example_util.js';
import {appendInstructions} from '../models/llm_request.js';

import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';

/**
 * A unique symbol to identify ADK example tool classes.
 * Defined once and shared by all ExampleTool instances.
 */
const EXAMPLE_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.exampleTool');

/**
 * Type guard to check if an object is an instance of ExampleTool.
 * @param obj The object to check.
 * @returns True if the object is an instance of ExampleTool, false otherwise.
 */
export function isExampleTool(obj: unknown): obj is ExampleTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    EXAMPLE_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[EXAMPLE_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * A tool that adds (few-shot) examples to the LLM request.
 *
 * This tool is executed for each LLM request and is never called by the model;
 * it only mutates the outgoing request by appending few-shot instructions built
 * from the latest user query.
 */
export class ExampleTool extends BaseTool {
  /** A unique symbol to identify ADK example tool class. */
  readonly [EXAMPLE_TOOL_SIGNATURE_SYMBOL] = true;

  constructor(readonly examples: Example[] | BaseExampleProvider) {
    super({
      // Name and description are not used because this tool only changes
      // llmRequest.
      name: 'example_tool',
      description: 'example tool',
    });
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
