/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';

import {appendInstructions} from '../models/llm_request.js';
import {logger} from '../utils/logger.js';
import {parseWithSchema, SchemaLike, toJsonSchema} from '../utils/schema.js';
import {isZodSchema} from '../utils/simple_zod_to_json.js';
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
export const FINISH_TASK_DEFAULT_WRAPPER_KEY = 'result';

/** The instruction {@link FinishTaskTool} appends to the request. */
export const FINISH_TASK_INSTRUCTION =
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
 * JSON Schema keys holding a definitions block. A `$ref` addresses one from the
 * document root, so the block has to stay at the root when the schema owning it
 * is nested under a wrapper property.
 */
const DEFINITION_KEYS = ['$defs', 'definitions'] as const;

/**
 * The task agent {@link FinishTaskTool.forAgent} reads.
 *
 * Structural rather than an `LlmAgent` import, so the tool does not depend on
 * the agent module — the same reason adk-python declares its `LlmAgent` import
 * under `TYPE_CHECKING`.
 */
export interface FinishTaskAgent {
  /** The agent's name, recorded on the tool for diagnostics. */
  readonly name: string;
  /** The agent's output schema in the genai dialect. */
  readonly outputSchema?: Schema;
  /** The agent's output schema as the caller supplied it. */
  readonly outputSchemaSource?: SchemaLike;
}

/** Options for the {@link FinishTaskTool} constructor. */
export interface FinishTaskToolOptions {
  /** The name of the task agent the tool belongs to. */
  taskAgentName?: string;
  /**
   * The schema arguments are validated against, when it differs from the
   * declared one. Defaults to the declared output schema.
   */
  validationSchema?: SchemaLike;
}

/**
 * The key `finish_task` arguments wrap the task output under, or `undefined`
 * when the schema is object-typed and the output sits at the top level of the
 * arguments.
 *
 * Mirrors adk-python's `_finish_task_tool.FinishTaskTool.__init__`, which keys
 * the decision off the declared `type` alone: a schema that declares
 * `properties` but no `type` counts as a non-object and is wrapped.
 */
export function getOutputWrapperKey(
  outputSchema?: SchemaLike,
): string | undefined {
  const schema = outputSchema ?? DEFAULT_TASK_OUTPUT_SCHEMA;
  return schemaTypeName(schema) === 'object'
    ? undefined
    : FINISH_TASK_DEFAULT_WRAPPER_KEY;
}

/**
 * The schema's declared top-level type, lowercased.
 *
 * A genai `Schema` and a raw JSON Schema record both carry `type` directly, in
 * either casing, and are read here rather than through `toJsonSchema`:
 * `genaiSchemaToJsonSchema` maps types through the genai `Type` enum, so it
 * drops a lowercase `'object'` it does not recognise.
 */
function schemaTypeName(schema: SchemaLike): string | undefined {
  const document = isZodSchema(schema)
    ? toJsonSchema(schema)
    : (schema as Record<string, unknown>);
  const type = document['type'];
  return typeof type === 'string' ? type.toLowerCase() : undefined;
}

/** Whether the schema carries a definitions block. */
function hasDefinitions(schema: object): boolean {
  const document = schema as Record<string, unknown>;
  return DEFINITION_KEYS.some((key) => document[key] !== undefined);
}

/** The `required` key list an object schema declares. */
function requiredKeys(schema: SchemaLike): string[] {
  const required = toJsonSchema(schema)['required'];
  return Array.isArray(required)
    ? required.filter((key): key is string => typeof key === 'string')
    : [];
}

/**
 * Wraps a schema document under `wrapperKey`, moving any definitions block to
 * the root of the wrapping document so its `$ref` pointers still resolve.
 */
function wrapWithHoistedDefinitions(
  wrapperKey: string,
  document: Record<string, unknown>,
): Record<string, unknown> {
  const inner = {...document};
  const definitions: Record<string, unknown> = {};
  for (const key of DEFINITION_KEYS) {
    if (inner[key] !== undefined) {
      definitions[key] = inner[key];
      delete inner[key];
    }
  }
  return {
    type: 'object',
    properties: {[wrapperKey]: inner},
    required: [wrapperKey],
    ...definitions,
  };
}

/** One `path: message` line per issue carried by a schema validation error. */
function describeIssues(error: unknown): string[] {
  const issues =
    typeof error === 'object' && error !== null && 'issues' in error
      ? (error as {issues: unknown}).issues
      : undefined;
  return Array.isArray(issues) ? issues.map(describeIssue) : [String(error)];
}

/** One `path: message` line for a single validation issue. */
function describeIssue(issue: unknown): string {
  if (typeof issue !== 'object' || issue === null) {
    return String(issue);
  }
  const {path, message} = issue as {path?: unknown; message?: unknown};
  const location = Array.isArray(path) ? path.join('.') : '';
  return `${location}: ${message ?? String(issue)}`;
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
  readonly outputSchema: SchemaLike;
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

  constructor(outputSchema?: SchemaLike, options: FinishTaskToolOptions = {}) {
    const schema = outputSchema ?? DEFAULT_TASK_OUTPUT_SCHEMA;
    let description =
      'Signal that this agent has completed its delegated task. Call this' +
      ' when you have finished your delegated task.';
    if (outputSchema) {
      description += ' Pass the required output data in the parameters.';
    }
    super({name: FINISH_TASK_TOOL_NAME, description});
    this.outputSchema = schema;
    this.wrapperKey = getOutputWrapperKey(schema);
    this.taskAgentName = options.taskAgentName;
    this.validationSchema = options.validationSchema ?? schema;
    this.requiredKeys = this.wrapperKey ? [] : requiredKeys(schema);
  }

  /**
   * Builds the tool for a task agent, reading its output schema and capturing
   * its name — the form adk-python's constructor takes.
   *
   * Arguments are checked against `outputSchemaSource` where the agent has one,
   * because the genai conversion loses the refinements and custom messages the
   * caller wrote. The declaration still comes from `outputSchema`, so the
   * preference leaves it unchanged.
   */
  static forAgent(taskAgent: FinishTaskAgent): FinishTaskTool {
    return new FinishTaskTool(taskAgent.outputSchema, {
      taskAgentName: taskAgent.name,
      validationSchema: taskAgent.outputSchemaSource ?? taskAgent.outputSchema,
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    const {name, description, outputSchema, wrapperKey} = this;
    const genaiSchema = isZodSchema(outputSchema)
      ? undefined
      : (outputSchema as Schema);
    if (!wrapperKey) {
      return genaiSchema
        ? {name, description, parameters: genaiSchema}
        : {name, description, parametersJsonSchema: toJsonSchema(outputSchema)};
    }
    if (genaiSchema && !hasDefinitions(genaiSchema)) {
      return {
        name,
        description,
        parameters: {
          type: Type.OBJECT,
          properties: {[wrapperKey]: genaiSchema},
          required: [wrapperKey],
        },
      };
    }
    return {
      name,
      description,
      parametersJsonSchema: wrapWithHoistedDefinitions(
        wrapperKey,
        toJsonSchema(outputSchema),
      ),
    };
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
    const missing = this.missingRequiredKeys(value);
    if (missing.length > 0) {
      return this.validationError(
        missing.map((key) => `${key}: field required`),
      );
    }
    try {
      parseWithSchema(this.validationSchema, value);
    } catch (error) {
      return this.validationError(describeIssues(error));
    }
    return FINISH_TASK_SUCCESS_RESULT;
  }

  /** Returns any `required` keys the schema declares that are absent. */
  private missingRequiredKeys(value: unknown): string[] {
    if (this.wrapperKey) {
      return value === undefined || value === null ? [this.wrapperKey] : [];
    }
    if (typeof value !== 'object' || value === null) {
      return [...this.requiredKeys];
    }
    const object = value as Record<string, unknown>;
    return this.requiredKeys.filter((key) => object[key] === undefined);
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
