/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema} from '@google/genai';

import {Context} from '../../agents/context.js';
import {
  ToolErrorType,
  ToolExecutionError,
} from '../../errors/tool_execution_error.js';
import {RunAsyncToolRequest} from '../../tools/base_tool.js';
import {FunctionTool} from '../../tools/function_tool.js';
import {formatError} from '../../utils/error_utils.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {resolveFullyQualifiedName} from '../../utils/module_utils.js';
import {toJsonSchema} from '../../utils/schema.js';
import {isZodSchema} from '../../utils/simple_zod_to_json.js';

/**
 * Argument names the framework manages. A model can emit any of them, so they
 * are removed before the arguments reach the wrapped tool.
 */
const RESERVED_ARG_NAMES: readonly string[] = [
  'self',
  'tool_context',
  'toolContext',
];

const DECLARATION_ERROR_PREFIX =
  'Failed to build function declaration for CrewAI tool: ';

/** The shape of a CrewAI-style tool that {@link CrewaiTool} can wrap. */
export interface CrewaiToolLike {
  /** The tool's own name, used unless the caller overrides it. */
  name?: string;
  /** The tool's own description, used unless the caller overrides it. */
  description?: string;
  /** A Zod schema (v3 or v4), or a plain JSON Schema object. */
  argsSchema?: unknown;
  /**
   * The tool's entry point. It receives the model's arguments object and, as
   * a second argument, the ADK context of the call.
   */
  run?(args: unknown, context?: Context): unknown;
}

/** Options for {@link CrewaiTool}. */
export interface CrewaiToolOptions {
  /** The CrewAI tool to wrap. */
  tool: CrewaiToolLike;
  /** Overrides the wrapped tool's name in the model-facing declaration. */
  name?: string;
  /** Overrides the wrapped tool's description. */
  description?: string;
}

/**
 * The declarative configuration of a {@link CrewaiTool}, as an agent config
 * file supplies it.
 *
 * It differs from {@link CrewaiToolOptions} because a config file cannot hold
 * a tool object. It names one instead.
 */
export interface CrewaiToolConfig {
  /**
   * A fully-qualified name of the form `<module specifier>#<export>` that
   * resolves to the CrewAI tool instance to wrap.
   */
  tool: string;
  /** Overrides the wrapped tool's name in the model-facing declaration. */
  name?: string;
  /** Overrides the wrapped tool's description. */
  description?: string;
}

/** The wrapped tool's entry point, bound to the tool. */
type CrewaiEntryPoint = (args: unknown, context?: Context) => unknown;

/**
 * Whether a value has the shape {@link CrewaiTool} can wrap.
 *
 * A structural check rather than an `instanceof`, so a tool built by a second
 * copy of a CrewAI package in the same runtime is still accepted.
 */
export function isCrewaiToolLike(
  value: unknown,
): value is Required<Pick<CrewaiToolLike, 'run'>> & CrewaiToolLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'run' in value &&
    typeof (value as CrewaiToolLike).run === 'function'
  );
}

/** The parameter schema of the wrapped tool, in the two forms callers need. */
interface ResolvedSchema {
  /** The model-facing declaration, absent when the tool declares no schema. */
  parameters?: Schema;
  /** The argument names the tool cannot run without. */
  requiredArgs: readonly string[];
}

/** Returns true when the value is a JSON object: not null and not an array. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveEntryPoint(tool: CrewaiToolLike): CrewaiEntryPoint {
  if (!isCrewaiToolLike(tool)) {
    throw new Error("Tool must be a CrewAI tool with a 'run' method.");
  }
  return tool.run.bind(tool);
}

function resolveName(options: CrewaiToolOptions): string {
  if (options.name) {
    return options.name;
  }
  const toolName = options.tool.name;
  if (toolName) {
    // CrewAI tool names contain spaces, which a function declaration cannot.
    return toolName.replace(/ /g, '_').toLowerCase();
  }
  throw new Error(
    'CrewaiTool requires a name: the wrapped tool has none, so pass `name`.',
  );
}

function toJsonSchemaDocument(argsSchema: unknown): Record<string, unknown> {
  if (isZodSchema(argsSchema)) {
    return toJsonSchema(argsSchema);
  }
  if (isJsonObject(argsSchema)) {
    return argsSchema;
  }
  throw new Error(`unsupported schema of type ${typeof argsSchema}`);
}

function readRequiredArgs(document: Record<string, unknown>): string[] {
  const {required} = document;
  if (!Array.isArray(required)) {
    return [];
  }
  return required.filter(
    (name: unknown): name is string => typeof name === 'string',
  );
}

function resolveSchema(tool: CrewaiToolLike): ResolvedSchema {
  const {argsSchema} = tool;
  if (argsSchema === undefined) {
    return {requiredArgs: []};
  }
  try {
    const document = toJsonSchemaDocument(argsSchema);
    const requiredArgs = readRequiredArgs(document);
    const properties = document.properties;
    return {
      parameters: toGeminiSchema({
        type: 'object',
        properties: isJsonObject(properties) ? properties : undefined,
        required: requiredArgs,
      }),
      requiredArgs,
    };
  } catch (error: unknown) {
    throw new Error(`${DECLARATION_ERROR_PREFIX}${formatError(error)}`);
  }
}

function stripReservedArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const stripped = {...args};
  for (const name of RESERVED_ARG_NAMES) {
    delete stripped[name];
  }
  return stripped;
}

function missingArgsError(name: string, missing: readonly string[]): string {
  return (
    `Invoking \`${name}()\` failed as the following mandatory input parameters are not present:\n` +
    `${missing.join('\n')}\n` +
    'You could retry calling this tool, but it is IMPORTANT for you to provide all the mandatory parameters.'
  );
}

/**
 * Wraps a CrewAI-style tool so an ADK agent can call it.
 *
 * The model-facing declaration comes from the wrapped tool's `argsSchema`, and
 * every argument the model supplies is passed on to `run` — the CrewAI
 * `**kwargs` contract — except the framework-reserved names. A call that omits
 * a required argument returns a retry hint instead of throwing, so the model
 * can correct itself.
 *
 * `@google/adk` takes no dependency on CrewAI: the wrapped tool is described
 * structurally by {@link CrewaiToolLike}.
 *
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'researcher',
 *   model: 'gemini-2.5-flash',
 *   tools: [new CrewaiTool({tool: searchTool})],
 * });
 * ```
 */
export class CrewaiTool extends FunctionTool<Schema> {
  private readonly requiredArgs: readonly string[];

  constructor(options: CrewaiToolOptions) {
    // Resolved first so a value that is not a CrewAI tool reports the missing
    // `run` rather than a missing name.
    const entryPoint = resolveEntryPoint(options.tool);
    const name = resolveName(options);
    const {parameters, requiredArgs} = resolveSchema(options.tool);
    super({
      name,
      description: options.description || options.tool.description || '',
      parameters,
      execute: (input, context) => entryPoint(input, context),
    });
    this.requiredArgs = requiredArgs;
  }

  /**
   * Builds a tool from the declarative configuration of an agent config file.
   *
   * An empty `name` or `description` counts as absent, so the wrapped tool
   * keeps its own. adk-python defaults both to `''` and reads them truthily,
   * so an empty string already means "absent" there too.
   *
   * @param config The tool configuration read from an agent config file.
   * @param configAbsPath Absolute path of that config file. A relative module
   *   specifier in `config.tool` resolves against its directory.
   * @return The configured tool.
   * @throws {ToolExecutionError} When `tool` is not a fully-qualified name, or
   *   names a value that is not a CrewAI tool.
   * @throws {InputValidationError} When `tool` is a name that does not resolve.
   */
  static async fromConfig(
    config: CrewaiToolConfig,
    configAbsPath: string,
  ): Promise<CrewaiTool> {
    // An agent config file is a trust boundary, so the declared `string` type
    // is checked rather than assumed.
    if (typeof config.tool !== 'string' || !config.tool) {
      throw new ToolExecutionError(
        'Crewai tool config must name a CrewAI tool instance with a ' +
          'fully-qualified name.',
        ToolErrorType.BAD_REQUEST,
      );
    }
    const tool = await resolveFullyQualifiedName(config.tool, configAbsPath);
    if (!isCrewaiToolLike(tool)) {
      throw new ToolExecutionError(
        'Crewai tool config must name a CrewAI tool instance.',
        ToolErrorType.BAD_REQUEST,
      );
    }
    return new CrewaiTool({
      tool,
      name: config.name,
      description: config.description,
    });
  }

  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    const args = stripReservedArgs(req.args);
    const missing = this.requiredArgs.filter((name) => !(name in args));
    if (missing.length > 0) {
      return {error: missingArgsError(this.name, missing)};
    }
    return super.runAsync({...req, args});
  }
}
