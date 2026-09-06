/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';

import {Event} from '../events/event.js';
import {appendInstructions} from '../models/llm_request.js';
import {getFunctionResponses} from '../models/llm_response.js';
import {
  describeSchemaIssues,
  isGenaiSchema,
  parseWithSchema,
  SchemaLike,
  toJsonSchema,
} from '../utils/schema.js';
import {
  BaseTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from './base_tool.js';
import {DEFAULT_TASK_OUTPUT_SCHEMA} from './task_models.js';

/** The name of the finish_task tool. */
export const FINISH_TASK_TOOL_NAME = 'finish_task';

/**
 * The result returned by {@link FinishTaskTool.runAsync} when validation passes.
 * The task-mode wrapper uses this to distinguish a successful completion from a
 * validation-error retry signal.
 */
export const FINISH_TASK_SUCCESS_RESULT = 'Task completed.';

/**
 * The terminal failure counterpart of {@link FINISH_TASK_SUCCESS_RESULT}.
 *
 * A task that reports this has finished: it will not read another user reply,
 * so its isolation scope closes just as it does on success. A remote task agent
 * reports a failed task this way, so the delegating agent can hand control back
 * to its coordinator.
 *
 * The tool itself never writes it, and neither does adk-python's tool. Both
 * SDKs recognise it on read, because a session is shared storage: adk-python's
 * `_finish_task_tool.py::is_finish_task_terminal_fr` accepts it, and a session
 * adk-python wrote can be read back here through the same session service. A
 * reader that did not recognise it would treat the finished task's isolation
 * scope as open and capture every later user turn into it.
 */
export const FINISH_TASK_ERROR_RESULT = 'Task failed.';

/**
 * Whether an event carries a terminal `finish_task` function response: one
 * reporting either success or failure.
 *
 * A response carrying anything else (a validation error, say) is not terminal,
 * so the caller keeps iterating and the agent gets a chance to retry.
 *
 * @param event The event to inspect.
 * @return `true` when the task has finished, either way.
 */
export function isFinishTaskTerminalResponse(event: Event): boolean {
  return getFunctionResponses(event).some((fr) => {
    if (fr.name !== FINISH_TASK_TOOL_NAME) {
      return false;
    }
    const {result} = (fr.response ?? {}) as {result?: unknown};
    return (
      result === FINISH_TASK_SUCCESS_RESULT ||
      result === FINISH_TASK_ERROR_RESULT
    );
  });
}

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

/**
 * JSON Schema keys that only carry meaning at the root of a document: the
 * definition block a `$ref` addresses from the root, and the dialect
 * declaration. Nesting a schema under a wrapper property would take them with
 * it, so they are lifted back out.
 */
const ROOT_ONLY_KEYS = ['$defs', '$schema'] as const;

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
 * The schema document a declaration and a wrapper key are read from.
 *
 * A Zod schema is serialized; every other form already is a JSON Schema record
 * in all but name. A genai `Schema` is read directly rather than through
 * `toJsonSchema`, because `genaiSchemaToJsonSchema` maps types through the
 * genai `Type` enum and so drops the lowercase `'object'` that a schema
 * deserialized from JSON carries.
 */
function schemaDocument(schema: SchemaLike): Record<string, unknown> {
  return isGenaiSchema(schema)
    ? (schema as Record<string, unknown>)
    : toJsonSchema(schema);
}

/** The schema's declared top-level type, lowercased. */
function schemaTypeName(schema: SchemaLike): string | undefined {
  const type = schemaDocument(schema)['type'];
  return typeof type === 'string' ? type.toLowerCase() : undefined;
}

/** Whether the document carries a key that has to stay at its root. */
function hasRootOnlyKeys(document: Record<string, unknown>): boolean {
  return ROOT_ONLY_KEYS.some((key) => document[key] !== undefined);
}

/** The `required` key list an object schema declares. */
function requiredKeys(schema: SchemaLike): string[] {
  const required = schemaDocument(schema)['required'];
  return Array.isArray(required)
    ? required.filter((key): key is string => typeof key === 'string')
    : [];
}

/**
 * Wraps a schema document under `wrapperKey`, hoisting its root-only keys to
 * the root of the wrapping document so its `$ref` pointers still resolve.
 */
function wrapWithHoistedRootKeys(
  wrapperKey: string,
  document: Record<string, unknown>,
): Record<string, unknown> {
  const inner = {...document};
  const hoisted: Record<string, unknown> = {};
  for (const key of ROOT_ONLY_KEYS) {
    if (inner[key] !== undefined) {
      hoisted[key] = inner[key];
      delete inner[key];
    }
  }
  return {
    ...hoisted,
    type: 'object',
    properties: {[wrapperKey]: inner},
    required: [wrapperKey],
  };
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

  /** The schema {@link runAsync} checks the model's arguments against. */
  private readonly validationSchema: SchemaLike;
  /** The `required` keys of an object output schema. */
  private readonly requiredKeys: readonly string[];

  /**
   * @param outputSchema The expected task output, defaulting to a single
   *   `result` string.
   * @param validationSchema The schema arguments are checked against,
   *   defaulting to `outputSchema`. A task agent passes its schema as the
   *   caller supplied it, because the genai form derived from it drops the
   *   refinements and custom messages the caller wrote.
   */
  constructor(outputSchema?: SchemaLike, validationSchema?: SchemaLike) {
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
    this.validationSchema = validationSchema ?? schema;
    this.requiredKeys = this.wrapperKey ? [] : requiredKeys(schema);
  }

  override _getDeclaration(): FunctionDeclaration {
    const {name, description, outputSchema, wrapperKey} = this;
    if (!isGenaiSchema(outputSchema)) {
      const document = toJsonSchema(outputSchema);
      return {
        name,
        description,
        parametersJsonSchema: wrapperKey
          ? wrapWithHoistedRootKeys(wrapperKey, document)
          : document,
      };
    }
    if (!wrapperKey) {
      return {name, description, parameters: outputSchema};
    }
    // Wrapping moves the schema into a property, which would take a `$defs`
    // block with it and leave every `#/$defs/...` pointer dangling. The genai
    // dialect has no field for one, but a declaration deserialized from JSON
    // still carries it.
    const document = schemaDocument(outputSchema);
    if (hasRootOnlyKeys(document)) {
      return {
        name,
        description,
        parametersJsonSchema: wrapWithHoistedRootKeys(wrapperKey, document),
      };
    }
    return {
      name,
      description,
      parameters: {
        type: Type.OBJECT,
        properties: {[wrapperKey]: outputSchema},
        required: [wrapperKey],
      },
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
    return {
      error:
        `Invoking \`${this.name}()\` failed due to validation errors:\n` +
        `${issues.join('\n')}\n` +
        'You could retry calling this tool, but it is IMPORTANT for you to' +
        ' provide all the mandatory parameters with correct types.',
    };
  }
}
