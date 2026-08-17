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
 * The argument key reserved for the ADK context. A model can hallucinate it,
 * so it is stripped from the arguments before the wrapped tool runs.
 */
const RESERVED_CONTEXT_ARG = 'tool_context';

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

  /**
   * JSON Schema for the tool's arguments. This is the analogue of the Python
   * tool's `args_schema.model_json_schema()`.
   */
  readonly argsSchema?: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };

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
 * Wraps a CrewAI tool so an ADK agent can call it.
 *
 * The adapter derives the function declaration from the wrapped tool's name,
 * description and argument schema, and delegates execution to its `run`
 * method. Override the name or the description when the CrewAI ones do not
 * suit the model.
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
    delete cleanedArgs[RESERVED_CONTEXT_ARG];
    return await this.tool.run(cleanedArgs, toolContext);
  }
}
