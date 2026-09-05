/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';

import {appendInstructions} from '../models/llm_request.js';
import {logger} from '../utils/logger.js';
import {
  describeSchemaIssues,
  parseWithSchema,
  SchemaLike,
} from '../utils/schema.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';

/** The name of the finish_task tool. */
export const FINISH_TASK_TOOL_NAME = 'finish_task';

/**
 * The result returned by {@link FinishTaskTool.runAsync} when validation passes.
 * The task-mode wrapper uses this to distinguish a successful completion from a
 * validation-error retry signal.
 */
export const FINISH_TASK_SUCCESS_RESULT = 'Task completed.';

/**
 * The parameter a non-object output schema is wrapped under, because the GenAI
 * API requires object-typed tool parameters.
 */
const DEFAULT_WRAPPER_KEY = 'result';

/** The instruction the tool appends to every request that declares it. */
const FINISH_TASK_INSTRUCTION =
  'Do NOT call `finish_task` prematurely. Use your available tools to fully' +
  ' complete every aspect of the task first. If the task is unclear, ask' +
  ' the user for clarification before proceeding. Once the task is fully' +
  ' complete, call `finish_task` by itself with no accompanying text' +
  ' output.';

/** The default output schema when the task agent declares none. */
const DEFAULT_TASK_OUTPUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    result: {
      type: Type.STRING,
      description: 'A brief summary of what the agent accomplished.',
    },
  },
  required: ['result'],
};

/**
 * The key `finish_task` arguments wrap the task output under, or `undefined`
 * when the schema is object-typed and the output sits at the top level of the
 * arguments.
 *
 * Mirrors adk-python's `_finish_task_tool.FinishTaskTool.__init__`, which keys
 * the decision off the declared `type` alone: a schema that declares
 * `properties` but no `type` counts as a non-object and is wrapped. A schema
 * deserialized from JSON carries a lowercase `type`, so the comparison ignores
 * case rather than testing the genai `Type` enum member.
 */
function outputWrapperKey(schema: Schema): string | undefined {
  return schema.type?.toLowerCase() === 'object'
    ? undefined
    : DEFAULT_WRAPPER_KEY;
}

/**
 * Tool for signaling that a task-mode {@link LlmAgent} has completed its task.
 *
 * The tool's parameters mirror the agent's `outputSchema` (or a default single
 * `result` string). The task-mode wrapper sniffs the `finish_task` function call
 * and, on a successful function response, promotes the call's arguments to the
 * node's output.
 *
 * Ported from `google/adk-python`
 * `agents/llm/task/_finish_task_tool.py::FinishTaskTool`.
 */
export class FinishTaskTool extends BaseTool {
  /** The schema describing the expected task output. */
  readonly outputSchema: Schema;
  /**
   * When the output schema is a non-object (primitive/array), the value is
   * wrapped under this key (the GenAI API requires object-typed parameters).
   * `undefined` for object schemas (the value lives at the top level of args).
   */
  readonly wrapperKey?: string;
  /** The name of the task agent this tool belongs to, when it is known. */
  readonly taskAgentName?: string;

  /** The schema {@link runAsync} checks the model's arguments against. */
  private readonly validationSchema: SchemaLike;
  /** The `required` keys of an object output schema. */
  private readonly requiredKeys: readonly string[];

  /**
   * @param outputSchema The expected task output, defaulting to a single
   *   `result` string.
   * @param taskAgentName The name of the task agent this tool belongs to,
   *   named in the log line a validation failure writes.
   * @param validationSchema The schema arguments are checked against,
   *   defaulting to `outputSchema`. A task agent passes its schema as the
   *   caller supplied it, because the genai form derived from it drops the
   *   refinements and custom messages the caller wrote.
   */
  constructor(
    outputSchema?: Schema,
    taskAgentName?: string,
    validationSchema?: SchemaLike,
  ) {
    const schema = outputSchema ?? DEFAULT_TASK_OUTPUT_SCHEMA;
    let description =
      'Signal that this agent has completed its delegated task. Call this' +
      ' when you have finished your delegated task.';
    if (outputSchema) {
      description += ' Pass the required output data in the parameters.';
    }
    super({name: FINISH_TASK_TOOL_NAME, description});
    this.outputSchema = schema;
    this.wrapperKey = outputWrapperKey(schema);
    this.taskAgentName = taskAgentName;
    this.validationSchema = validationSchema ?? schema;
    this.requiredKeys = this.wrapperKey ? [] : (schema.required ?? []);
  }

  override _getDeclaration(): FunctionDeclaration {
    const parameters: Schema = this.wrapperKey
      ? {
          type: Type.OBJECT,
          properties: {[this.wrapperKey]: this.outputSchema},
          required: [this.wrapperKey],
        }
      : this.outputSchema;
    return {name: this.name, description: this.description, parameters};
  }

  override async processLlmRequest(
    request: ToolProcessLlmRequest,
  ): Promise<void> {
    await super.processLlmRequest(request);
    // Tell the model when to call finish_task (mirrors Python's tool
    // instruction), so it completes the task deliberately.
    appendInstructions(request.llmRequest, [FINISH_TASK_INSTRUCTION]);
  }

  /**
   * Extracts the task output from a `finish_task` call's arguments, applying the
   * wrapper-key unwrapping when the schema is a non-object.
   */
  extractOutput(args: Record<string, unknown>): unknown {
    if (this.wrapperKey) {
      return args[this.wrapperKey];
    }
    return args;
  }

  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    const value = this.wrapperKey ? args[this.wrapperKey] : args;
    // The presence check is the floor: `parseWithSchema` returns the value
    // unvalidated for a schema it cannot compile, so dropping it would lose the
    // check the tool already performs.
    const missing = this.missingRequiredKeys(args);
    if (missing.length > 0) {
      return this.validationError(
        missing.map((key) => `${key}: field required`),
      );
    }
    try {
      parseWithSchema(this.validationSchema, value);
    } catch (error) {
      return this.validationError(describeSchemaIssues(error));
    }
    return FINISH_TASK_SUCCESS_RESULT;
  }

  /** Returns any `required` keys the arguments do not carry. */
  private missingRequiredKeys(args: Record<string, unknown>): string[] {
    if (this.wrapperKey) {
      const wrapped = args[this.wrapperKey];
      return wrapped === undefined || wrapped === null ? [this.wrapperKey] : [];
    }
    return this.requiredKeys.filter((key) => args[key] === undefined);
  }

  /** The retry payload the model receives when its arguments do not validate. */
  private validationError(issues: string[]): {error: string} {
    logger.debug(
      `${this.name} validation failed for agent` +
        ` ${this.taskAgentName ?? '<unnamed>'}: ${issues.join('; ')}`,
    );
    return {
      error:
        `Invoking \`${this.name}()\` failed due to validation errors:\n` +
        `${issues.join('\n')}\n` +
        'You could retry calling this tool, but it is IMPORTANT for you to' +
        ' provide all the mandatory parameters with correct types.',
    };
  }
}
