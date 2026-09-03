/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ComputerUse, Environment} from '@google/genai';

import {Context} from '../../agents/context.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {LlmRequest} from '../../models/llm_request.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {
  assertSchemeAllowed,
  isBlockedHostname,
  normalizeHost,
  validateResolvedAddresses,
} from '../../utils/url_safety_utils.js';
import {BaseToolset} from '../base_toolset.js';
import {ToolInputParameters} from '../function_tool.js';

import {BaseComputer, ComputerEnvironment} from './base_computer.js';
import {
  ComputerUseFunction,
  ComputerUseTool,
  isComputerUseTool,
} from './computer_use_tool.js';
import {
  NAVIGATE_FUNCTION_NAME,
  PREDEFINED_COMPUTER_FUNCTIONS,
  PredefinedComputerFunction,
} from './predefined_functions.js';

/** The response a refused `navigate` returns instead of driving the browser. */
const URL_REFUSED_ERROR =
  'navigate refused: url must be http(s) and must not target a private or' +
  ' link-local address.';

/** Maps a computer environment onto the genai enum member of the same name. */
const GENAI_ENVIRONMENTS: Readonly<Record<ComputerEnvironment, Environment>> = {
  [ComputerEnvironment.ENVIRONMENT_UNSPECIFIED]:
    Environment.ENVIRONMENT_UNSPECIFIED,
  [ComputerEnvironment.ENVIRONMENT_BROWSER]: Environment.ENVIRONMENT_BROWSER,
};

/** The options for creating a {@link ComputerUseToolset}. */
export interface ComputerUseToolsetOptions {
  /** The computer environment to expose as tools. */
  computer: BaseComputer;
  /** Wire names of predefined functions not to expose, e.g. `drag_and_drop`. */
  excludedPredefinedFunctions?: string[];
  /**
   * Whether `navigate` may reach a host that is not publicly routable. Set
   * this when the agent is meant to drive a browser against localhost or an
   * internal host. Defaults to `false`.
   */
  allowPrivateNetworkAccess?: boolean;
}

/** The tool an adapter asks {@link ComputerUseToolset} to register. */
export interface AdaptedComputerUseFunction {
  /** The wire name to register the adapted tool under. */
  name: string;
  /** Defaults to the original tool's description. */
  description?: string;
  /**
   * The schema of the adapted tool's arguments. Defaults to the original
   * tool's schema, so an adapter that changes the argument shape must declare
   * the new one.
   */
  parameters?: ToolInputParameters;
  /** The function that performs the adapted action. */
  execute: ComputerUseFunction;
}

/** Builds a replacement for one already-registered computer-use tool. */
export type ComputerUseToolAdapter = (
  original: ComputerUseFunction,
) => AdaptedComputerUseFunction | Promise<AdaptedComputerUseFunction>;

/** Reads the `url` argument of a `navigate` call. */
function readUrlArgument(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || !('url' in args)) {
    return undefined;
  }
  return typeof args.url === 'string' ? args.url : undefined;
}

/** Returns the authority of `url` exactly as it was written. */
function rawAuthority(url: string): string {
  const separator = '://';
  const rest = url.slice(url.indexOf(separator) + separator.length);
  const end = rest.search(/[/?#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Whether the model-supplied `url` may be handed to the browser.
 *
 * The check is made from the URL alone whenever it can be, so an unsafe URL
 * costs neither a DNS lookup nor a driver call.
 */
async function isNavigationAllowed(
  url: string,
  allowPrivateNetworkAccess: boolean,
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = assertSchemeAllowed(url);
  } catch {
    return false;
  }
  // A browser ends the authority at a backslash and other parsers do not, so
  // they disagree about the host of `http://169.254.169.254\@example.com/`.
  // Refuse rather than pick a reading.
  if (rawAuthority(url).includes('\\')) {
    return false;
  }
  // Both host checks are skipped together, so `localhost` and a loopback
  // literal behave the same way once the caller opts in.
  if (allowPrivateNetworkAccess) {
    return true;
  }
  if (isBlockedHostname(parsed.hostname)) {
    return false;
  }
  try {
    await validateResolvedAddresses(normalizeHost(parsed.hostname));
  } catch {
    return false;
  }
  return true;
}

/**
 * Exposes a {@link BaseComputer} to a model as a set of computer-use tools,
 * and attaches the matching computer-use configuration to the request.
 *
 * The toolset owns the computer's lifecycle: it initializes the computer once,
 * calls `prepare` before every action, and closes it on {@link close}.
 */
@experimental
export class ComputerUseToolset extends BaseToolset {
  private readonly computer: BaseComputer;
  private readonly excludedPredefinedFunctions?: string[];
  private readonly allowPrivateNetworkAccess: boolean;
  private initialization?: Promise<void>;
  private tools?: ComputerUseTool[];

  constructor(options: ComputerUseToolsetOptions) {
    super([]);
    this.computer = options.computer;
    this.excludedPredefinedFunctions = options.excludedPredefinedFunctions;
    this.allowPrivateNetworkAccess = options.allowPrivateNetworkAccess ?? false;
  }

  /**
   * Returns one tool per predefined function the caller did not exclude.
   *
   * The tools are built once and the same array is returned afterwards, so a
   * caller can hold on to the instances.
   */
  override async getTools(
    _context?: ReadonlyContext,
  ): Promise<ComputerUseTool[]> {
    if (this.tools) {
      return this.tools;
    }
    this.initialization ??= this.computer.initialize();
    await this.initialization;

    const [screenSize, environment] = await Promise.all([
      this.computer.screenSize(),
      this.computer.environment(),
    ]);
    const computerUse: ComputerUse = {
      environment:
        GENAI_ENVIRONMENTS[environment] ?? Environment.ENVIRONMENT_BROWSER,
      excludedPredefinedFunctions: this.excludedPredefinedFunctions,
    };
    const excluded = new Set(this.excludedPredefinedFunctions ?? []);
    this.tools = PREDEFINED_COMPUTER_FUNCTIONS.filter(
      (predefined) => !excluded.has(predefined.name),
    ).map(
      (predefined) =>
        new ComputerUseTool({
          name: predefined.name,
          description: predefined.description,
          parameters: predefined.parameters,
          screenSize,
          computerUse,
          execute: (args, toolContext) =>
            this.runPredefinedFunction(predefined, args, toolContext),
        }),
    );
    return this.tools;
  }

  override async close(): Promise<void> {
    return this.computer.close();
  }

  /**
   * Registers this toolset's tools and adds the computer-use configuration the
   * model needs in order to call them.
   *
   * An `LlmAgent` never reaches this method: it expands a toolset into its
   * tools and calls `processLlmRequest` on each one. The work therefore lives
   * in {@link ComputerUseTool.processLlmRequest} and this delegates to it, so
   * the toolset hook that adk-python drives runs the same code.
   */
  override async processLlmRequest(
    toolContext: Context,
    llmRequest: LlmRequest,
  ): Promise<void> {
    for (const tool of await this.getTools()) {
      await tool.processLlmRequest({toolContext, llmRequest});
    }
  }

  /**
   * Replaces one registered computer-use tool with a caller-adapted version.
   *
   * The adapter receives the original function and returns the tool to
   * register in its place. The request is left untouched when the name is not
   * a predefined function, when no tool is registered under it, or when the
   * adapter returns an unnamed tool.
   *
   * @param methodName The wire name of the tool to adapt, e.g. `wait`.
   * @param adapter Builds the replacement from the original function.
   * @param llmRequest The request holding the registered tools.
   */
  static async adaptComputerUseTool(
    methodName: string,
    adapter: ComputerUseToolAdapter,
    llmRequest: LlmRequest,
  ): Promise<void> {
    if (
      !PREDEFINED_COMPUTER_FUNCTIONS.some(
        (predefined) => predefined.name === methodName,
      )
    ) {
      logger.warn(`Method ${methodName} is not a predefined computer function`);
      return;
    }

    const original = llmRequest.toolsDict[methodName];
    if (!isComputerUseTool(original)) {
      logger.warn(`Method ${methodName} not found in toolsDict`);
      return;
    }

    const adapted = await adapter(original.func);
    if (!adapted.name) {
      logger.warn(`Adapter for ${methodName} returned an unnamed tool`);
      return;
    }

    const adaptedTool = new ComputerUseTool({
      name: adapted.name,
      description: adapted.description ?? original.description,
      parameters: adapted.parameters ?? original._getDeclaration().parameters,
      execute: adapted.execute,
      screenSize: original.screenSize,
      virtualScreenSize: original.virtualScreenSize,
      computerUse: original.computerUse,
    });

    delete llmRequest.toolsDict[methodName];
    llmRequest.toolsDict[adapted.name] = adaptedTool;
  }

  /**
   * Prepares the computer, applies the `navigate` URL guard, and runs the
   * action.
   */
  private async runPredefinedFunction(
    predefined: PredefinedComputerFunction,
    args: unknown,
    toolContext?: Context,
  ): Promise<unknown> {
    if (toolContext) {
      await this.computer.prepare(toolContext);
    }
    if (predefined.name !== NAVIGATE_FUNCTION_NAME) {
      return predefined.invoke(this.computer, args);
    }

    const url = readUrlArgument(args);
    if (
      url === undefined ||
      !(await isNavigationAllowed(url, this.allowPrivateNetworkAccess))
    ) {
      logger.warn('Refusing navigate(): url failed safety validation.');
      // The computer-use model rejects a function response carrying no url, so
      // report the page the browser is still on.
      const state = await this.computer.currentState();
      return {error: URL_REFUSED_ERROR, url: state.url};
    }
    return predefined.invoke(this.computer, args);
  }
}
