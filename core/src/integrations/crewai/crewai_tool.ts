/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema} from '@google/genai';

import {Context} from '../../agents/context.js';
import {FunctionTool} from '../../tools/function_tool.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';

/**
 * The argument keys reserved for the ADK context. A model can hallucinate
 * either spelling, so both are stripped before the wrapped tool runs. The
 * context reaches the tool as `run`'s second parameter, never as an argument.
 * A CrewAI schema ported from Python names the parameter `tool_context`; a
 * TypeScript one names it `toolContext`.
 */
const RESERVED_CONTEXT_ARGS = ['tool_context', 'toolContext'];

/**
 * The JSON Schema a CrewAI tool publishes for its arguments. This is the
 * analogue of the Python tool's `args_schema.model_json_schema()`.
 */
export interface CrewaiToolArgsSchema {
  /**
   * Widened to `string` on purpose. A literal `'object'` would force every
   * caller to annotate the tool object, because TypeScript widens the property
   * of an unannotated literal to `string`. A tool built by a CrewAI port
   * carries that library's own typing and could not be annotated at all.
   */
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

/**
 * Narrows the value `FunctionTool` passes to `execute` to the model's argument
 * record.
 *
 * `FunctionTool` types that parameter from its schema type, and this class
 * declares no `parameters`, so the static type is `unknown`. `BaseTool` types
 * the arguments as a record, so the guard always holds at run time.
 */
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
   * `FunctionTool` builds its declaration from the `parameters` option, which
   * this class does not use. The declaration comes from the wrapped tool's own
   * schema instead.
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
