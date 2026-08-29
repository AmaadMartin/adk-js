/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema} from '@google/genai';

import {Context} from '../../agents/context.js';
import {FunctionTool} from '../../tools/function_tool.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';

/** Argument keys stripped before `run`, which receives the context separately. */
const RESERVED_CONTEXT_ARGS = ['tool_context', 'toolContext'];

/**
 * The JSON Schema a CrewAI tool publishes for its arguments. This is the
 * analogue of the Python tool's `args_schema.model_json_schema()`.
 */
export interface CrewaiToolArgsSchema {
  /** Widened from the literal `'object'` so an unannotated literal assigns. */
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

/**
 * The structural shape of a CrewAI tool.
 *
 * This interface is declared here rather than imported: CrewAI ships a Python
 * SDK, so there is no first-party npm package to depend on. Any object with
 * these members can be wrapped, and importing `@google/adk` never requires a
 * CrewAI package to be installed.
 */
export interface CrewaiBaseTool {
  /** Display name, for example `'Serper Dev Tool'`. */
  readonly name: string;

  readonly description: string;

  /** JSON Schema for the tool's arguments. */
  readonly argsSchema?: CrewaiToolArgsSchema;

  run(
    args: Record<string, unknown>,
    toolContext?: Context,
  ): unknown | Promise<unknown>;
}

/** Overrides for the wrapped tool's own name and description. */
export interface CrewaiToolOptions {
  name?: string;
  description?: string;
}

/**
 * Resolves the name declared to the model.
 *
 * An explicit option wins verbatim. Otherwise the CrewAI display name is
 * normalised, because CrewAI names contain spaces and a function declaration
 * name cannot.
 */
function resolveName(tool: CrewaiBaseTool, options: CrewaiToolOptions): string {
  if (options.name) {
    return options.name;
  }
  if (tool.name) {
    return tool.name.replaceAll(' ', '_').toLowerCase();
  }
  throw new Error(
    'Tool name cannot be empty. Either provide a `name` option or set a name on the CrewAI tool.',
  );
}

/**
 * Reports the arguments the schema requires but the call omitted.
 *
 * Returns the payload to hand back to the model instead of running the tool,
 * or `undefined` when every required argument is present. The model is told
 * what is missing so that it can retry, which is why this is a value and not a
 * thrown error. The wording matches adk-python so that a model tuned on one
 * SDK reads the same hint from the other.
 */
function missingArgsError(
  toolName: string,
  required: readonly string[],
  args: Record<string, unknown>,
): {error: string} | undefined {
  const missing = required.filter((name) => !(name in args));
  if (missing.length === 0) {
    return undefined;
  }
  return {
    error:
      `Invoking \`${toolName}()\` failed as the following mandatory input parameters are not present:\n` +
      `${missing.join('\n')}\n` +
      'You could retry calling this tool, but it is IMPORTANT for you to provide all the mandatory parameters.',
  };
}

/** Narrows `execute`'s argument, which this class's schema type leaves `unknown`. */
function isArgsRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

/**
 * Calls the wrapped tool the way CrewAI expects.
 *
 * Every model-supplied argument is forwarded except the reserved context keys.
 * The ADK context is supplied separately, as `run`'s second parameter.
 */
function runCrewaiTool(
  tool: CrewaiBaseTool,
  toolName: string,
  args: Record<string, unknown>,
  toolContext?: Context,
): unknown | Promise<unknown> {
  const cleanedArgs = {...args};
  for (const reservedArg of RESERVED_CONTEXT_ARGS) {
    delete cleanedArgs[reservedArg];
  }

  return (
    missingArgsError(toolName, tool.argsSchema?.required ?? [], cleanedArgs) ??
    tool.run(cleanedArgs, toolContext)
  );
}

/**
 * Wraps a CrewAI tool so an ADK agent can call it.
 *
 * The adapter derives the function declaration from the wrapped tool's name,
 * description and argument schema, and delegates execution to its `run`
 * method. Override the name or the description when the CrewAI ones do not
 * suit the model.
 *
 * When a call omits an argument the schema lists in `required`, the adapter
 * returns an `{error}` payload naming the missing arguments instead of running
 * the tool, so that the model can retry with them.
 *
 * @example
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'researcher',
 *   model: 'gemini-2.5-flash',
 *   tools: [new CrewaiTool(serperDevTool)],
 * });
 * ```
 */
export class CrewaiTool extends FunctionTool<Schema> {
  /** The wrapped CrewAI tool. */
  readonly tool: CrewaiBaseTool;

  constructor(tool: CrewaiBaseTool, options: CrewaiToolOptions = {}) {
    const name = resolveName(tool, options);
    super({
      name,
      description: options.description || tool.description || '',
      execute: (input, toolContext) =>
        runCrewaiTool(
          tool,
          name,
          isArgsRecord(input) ? input : {},
          toolContext,
        ),
    });
    this.tool = tool;
  }

  /**
   * Overridden to leave `parameters` unset for a tool with no properties,
   * where the base class emits an empty object schema. adk-python does the
   * same: `build_function_declaration_util` sets `parameters=... if properties
   * else None`.
   */
  override _getDeclaration(): FunctionDeclaration {
    const argsSchema = this.tool.argsSchema;
    const hasProperties = Object.keys(argsSchema?.properties ?? {}).length > 0;
    return {
      name: this.name,
      description: this.description,
      parameters: hasProperties
        ? toGeminiSchema({
            type: 'object',
            properties: argsSchema?.properties,
            required: argsSchema?.required,
          })
        : undefined,
    };
  }
}
