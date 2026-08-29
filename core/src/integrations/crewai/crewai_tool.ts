/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';

import {Context} from '../../agents/context.js';
import {BaseTool, RunAsyncToolRequest} from '../../tools/base_tool.js';
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
  type: 'object';
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
export class CrewaiTool extends BaseTool {
  /** The wrapped CrewAI tool. */
  readonly tool: CrewaiBaseTool;

  constructor(tool: CrewaiBaseTool, options: CrewaiToolOptions = {}) {
    super({
      name: resolveName(tool, options),
      description: options.description || tool.description || '',
    });
    this.tool = tool;
  }

  override _getDeclaration(): FunctionDeclaration {
    const argsSchema = this.tool.argsSchema;
    const hasProperties = Object.keys(argsSchema?.properties ?? {}).length > 0;
    return {
      name: this.name,
      description: this.description,
      parameters: hasProperties ? toGeminiSchema(argsSchema) : undefined,
    };
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const cleanedArgs = {...args};
    for (const reservedArg of RESERVED_CONTEXT_ARGS) {
      delete cleanedArgs[reservedArg];
    }

    const error = missingArgsError(
      this.name,
      this.tool.argsSchema?.required ?? [],
      cleanedArgs,
    );
    if (error) {
      return error;
    }

    return await this.tool.run(cleanedArgs, toolContext);
  }
}
