/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Environment} from '@google/genai';
import {z} from 'zod';

import {Context} from '../../agents/context.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {LlmRequest} from '../../models/llm_request.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {
  assertPubliclyRoutable,
  hasBackslashInAuthority,
  isBlockedHostname,
  parseRequestTarget,
} from '../../utils/url_safety_utils.js';
import {BaseToolset} from '../base_toolset.js';

import {
  BaseComputer,
  ComputerEnvironment,
  ComputerState,
} from './base_computer.js';
import {ComputerUseTool, isComputerUseTool} from './computer_use_tool.js';

/** What a refused `navigate` reports back to the model. */
export const URL_REFUSED_ERROR =
  'navigate refused: url must be http(s) and must not target a private or link-local address.';

/** The wire name of the one action that takes a model-authored url. */
const NAVIGATE_ACTION = 'navigate';

/** The configuration of a {@link ComputerUseToolset}. */
export interface ComputerUseToolsetOptions {
  /** The driver the actions run against. */
  computer: BaseComputer;
  /**
   * The wire names of predefined functions not to expose, e.g.
   * `['drag_and_drop']`. Also sent to the model, which stops declaring them.
   */
  excludedPredefinedFunctions?: string[];
  /**
   * Whether `navigate` may target a host that is not publicly routable.
   * Defaults to false, which refuses `localhost` and any private, loopback or
   * link-local address. Set it to true to drive the browser against a local
   * development server.
   */
  allowPrivateNetworkAccess?: boolean;
}

/** The arguments of {@link ComputerUseToolset.adaptComputerUseTool}. */
export interface AdaptComputerUseToolOptions {
  /** The wire name of the action to replace, e.g. `wait`. */
  name: string;
  /** The request whose `toolsDict` holds the action. */
  llmRequest: LlmRequest;
  /** Builds the replacement, which carries the name it is registered under. */
  adapt(tool: ComputerUseTool): ComputerUseTool | Promise<ComputerUseTool>;
}

/** One predefined computer-use action and the driver call it makes. */
interface ComputerAction {
  /** The wire name the model calls the action by. */
  readonly name: string;
  /** What the action does. */
  readonly description: string;
  /** The schema of the action's arguments, keyed by their wire names. */
  readonly parameters: z.ZodObject;
  /** Calls the driver with the validated arguments. */
  run(
    args: Record<string, unknown>,
    computer: BaseComputer,
  ): Promise<ComputerState>;
}

/**
 * Declares an action, keeping the argument type its schema implies.
 *
 * @param action The action to declare.
 * @return The action, with its arguments widened for the table.
 */
function defineAction<T extends z.ZodObject>(action: {
  name: string;
  description: string;
  parameters: T;
  run(args: z.infer<T>, computer: BaseComputer): Promise<ComputerState>;
}): ComputerAction {
  return action;
}

/** The arguments of an action that takes no argument. */
const NO_ARGS = z.object({});

/** The arguments of an action that acts on one point of the screen. */
const POINT = z.object({x: z.number(), y: z.number()});

/** The direction a scroll action moves the page in. */
const DIRECTION = z.enum(['up', 'down', 'left', 'right']);

/**
 * The names of the {@link BaseComputer} methods that are actions. The
 * remaining methods are lifecycle, not an action space the model can call.
 */
type ActionMethod = Exclude<
  keyof BaseComputer,
  'prepare' | 'initialize' | 'close' | 'screenSize' | 'environment'
>;

/**
 * The predefined Gemini computer-use action space.
 *
 * `adk-python` derives this list by reflecting over `BaseComputer`. TypeScript
 * has no runtime signatures, so the table is explicit — and typed as a record
 * over the driver's action methods, so adding one to {@link BaseComputer}
 * without declaring it here fails to compile.
 */
const ACTIONS: Record<ActionMethod, ComputerAction> = {
  openWebBrowser: defineAction({
    name: 'open_web_browser',
    description: 'Opens the web browser.',
    parameters: NO_ARGS,
    run: (_args, computer) => computer.openWebBrowser(),
  }),
  clickAt: defineAction({
    name: 'click_at',
    description:
      "Clicks at a specific x, y coordinate on the webpage. The 'x' and 'y' values are absolute values, scaled to the height and width of the screen.",
    parameters: POINT,
    run: (args, computer) => computer.clickAt(args),
  }),
  hoverAt: defineAction({
    name: 'hover_at',
    description:
      "Hovers at a specific x, y coordinate on the webpage. May be used to explore sub-menus that appear on hover. The 'x' and 'y' values are absolute values, scaled to the height and width of the screen.",
    parameters: POINT,
    run: (args, computer) => computer.hoverAt(args),
  }),
  typeTextAt: defineAction({
    name: 'type_text_at',
    description:
      "Types text at a specific x, y coordinate. The system automatically presses ENTER after typing. To disable this, set `press_enter` to false. The system automatically clears any existing content before typing the specified `text`. To disable this, set `clear_before_typing` to false. The 'x' and 'y' values are absolute values, scaled to the height and width of the screen.",
    parameters: z.object({
      x: z.number(),
      y: z.number(),
      text: z.string(),
      press_enter: z.boolean().default(true),
      clear_before_typing: z.boolean().default(true),
    }),
    run: (args, computer) =>
      computer.typeTextAt({
        x: args.x,
        y: args.y,
        text: args.text,
        pressEnter: args.press_enter,
        clearBeforeTyping: args.clear_before_typing,
      }),
  }),
  scrollDocument: defineAction({
    name: 'scroll_document',
    description:
      'Scrolls the entire webpage "up", "down", "left" or "right" based on direction.',
    parameters: z.object({direction: DIRECTION}),
    run: (args, computer) => computer.scrollDocument(args),
  }),
  scrollAt: defineAction({
    name: 'scroll_at',
    description:
      "Scrolls up, down, right, or left at a x, y coordinate by magnitude. The 'x' and 'y' values are absolute values, scaled to the height and width of the screen.",
    parameters: z.object({
      x: z.number(),
      y: z.number(),
      direction: DIRECTION,
      magnitude: z.number(),
    }),
    run: (args, computer) => computer.scrollAt(args),
  }),
  wait: defineAction({
    name: 'wait',
    description:
      'Waits for n seconds to allow unfinished webpage processes to complete.',
    parameters: z.object({seconds: z.number()}),
    run: (args, computer) => computer.wait(args),
  }),
  goBack: defineAction({
    name: 'go_back',
    description:
      'Navigates back to the previous webpage in the browser history.',
    parameters: NO_ARGS,
    run: (_args, computer) => computer.goBack(),
  }),
  goForward: defineAction({
    name: 'go_forward',
    description:
      'Navigates forward to the next webpage in the browser history.',
    parameters: NO_ARGS,
    run: (_args, computer) => computer.goForward(),
  }),
  search: defineAction({
    name: 'search',
    description:
      'Directly jumps to a search engine home page. Used when you need to start with a search, because the current website does not have the information needed or because a new task is being started.',
    parameters: NO_ARGS,
    run: (_args, computer) => computer.search(),
  }),
  navigate: defineAction({
    name: NAVIGATE_ACTION,
    description: 'Navigates directly to a specified URL.',
    parameters: z.object({url: z.string()}),
    run: (args, computer) => computer.navigate(args),
  }),
  keyCombination: defineAction({
    name: 'key_combination',
    description:
      'Presses keyboard keys and combinations, such as "control+c" or "enter".',
    parameters: z.object({keys: z.array(z.string())}),
    run: (args, computer) => computer.keyCombination(args),
  }),
  dragAndDrop: defineAction({
    name: 'drag_and_drop',
    description:
      "Drag and drop an element from a x, y coordinate to a destination destination_x, destination_y coordinate. The 'x', 'y', 'destination_x' and 'destination_y' values are absolute values, scaled to the height and width of the screen.",
    parameters: z.object({
      x: z.number(),
      y: z.number(),
      destination_x: z.number(),
      destination_y: z.number(),
    }),
    run: (args, computer) =>
      computer.dragAndDrop({
        x: args.x,
        y: args.y,
        destinationX: args.destination_x,
        destinationY: args.destination_y,
      }),
  }),
  currentState: defineAction({
    name: 'current_state',
    description: 'Returns the current state of the current webpage.',
    parameters: NO_ARGS,
    run: (_args, computer) => computer.currentState(),
  }),
};

/** The wire names of every predefined action. */
const ACTION_WIRE_NAMES: ReadonlySet<string> = new Set(
  Object.values(ACTIONS).map((action) => action.name),
);

/**
 * Exposes a {@link BaseComputer} to the model as the predefined Gemini
 * computer-use functions.
 *
 * The toolset attaches the `Tool.computerUse` config to the outgoing request,
 * which is what makes the API declare the functions; the tools themselves
 * declare nothing. It also registers each action in `llmRequest.toolsDict`,
 * which is what makes a function call routable back to the driver.
 *
 * @example
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'browser_agent',
 *   model: 'gemini-2.5-computer-use-preview-10-2025',
 *   tools: [new ComputerUseToolset({computer: new MyComputer()})],
 * });
 * ```
 */
@experimental
export class ComputerUseToolset extends BaseToolset {
  private readonly computer: BaseComputer;
  private readonly excludedPredefinedFunctions?: string[];
  private readonly allowPrivateNetworkAccess: boolean;
  /** Memoized so the driver initializes once, even under concurrent callers. */
  private tools?: Promise<ComputerUseTool[]>;

  /**
   * @param options The configuration of the toolset.
   */
  constructor(options: ComputerUseToolsetOptions) {
    // The wire names are fixed by the Gemini API, so no name prefix and no
    // tool filter: a renamed action would not dispatch.
    super([]);
    this.computer = options.computer;
    this.excludedPredefinedFunctions = options.excludedPredefinedFunctions;
    this.allowPrivateNetworkAccess = options.allowPrivateNetworkAccess ?? false;
  }

  /**
   * The predefined actions, minus the excluded ones. Initializes the driver on
   * the first call and reads its screen size.
   *
   * @param _context Unused: the action space does not depend on the context.
   * @return The tools, the same array on every call.
   */
  override getTools(_context?: ReadonlyContext): Promise<ComputerUseTool[]> {
    this.tools ??= this.createTools();
    return this.tools;
  }

  /** Closes the driver. */
  override async close(): Promise<void> {
    return this.computer.close();
  }

  /**
   * Registers the actions on the request and asks the API to declare the
   * computer-use functions.
   *
   * @param _toolContext Unused: the configuration does not depend on the call.
   * @param llmRequest The outgoing request, mutated in place.
   */
  override async processLlmRequest(
    _toolContext: Context,
    llmRequest: LlmRequest,
  ): Promise<void> {
    try {
      for (const tool of await this.getTools()) {
        // An action a request processor filtered out must not stay callable.
        if (
          !llmRequest.allowedTools ||
          llmRequest.allowedTools.includes(tool.name)
        ) {
          llmRequest.toolsDict[tool.name] = tool;
        }
      }

      llmRequest.config ??= {};
      llmRequest.config.tools ??= [];
      if (
        llmRequest.config.tools.some(
          (tool) => 'computerUse' in tool && tool.computerUse,
        )
      ) {
        logger.debug('Computer use already configured in LLM request');
        return;
      }

      const environment = await this.computer.environment();
      llmRequest.config.tools.push({
        computerUse: {
          environment: toGenaiEnvironment(environment),
          excludedPredefinedFunctions: this.excludedPredefinedFunctions,
        },
      });
      logger.debug(
        `Added computer use tool with environment: ${environment}, excluded functions: ${this.excludedPredefinedFunctions}`,
      );
    } catch (error) {
      logger.error(
        `Error in ComputerUseToolset.processLlmRequest: ${String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Replaces one registered action with an adapted version of it, for example
   * to give `wait` a different description or a bounded duration.
   *
   * Never throws: an unknown action, or one absent from the request, logs a
   * warning and leaves `toolsDict` untouched.
   *
   * @param options The action to replace and how to replace it.
   */
  static async adaptComputerUseTool({
    name,
    llmRequest,
    adapt,
  }: AdaptComputerUseToolOptions): Promise<void> {
    if (!ACTION_WIRE_NAMES.has(name)) {
      logger.warn(`${name} is not a predefined computer use function`);
      return;
    }
    const original = llmRequest.toolsDict[name];
    if (!isComputerUseTool(original)) {
      logger.warn(`${name} is not a registered computer use tool`);
      return;
    }
    const adapted = await adapt(original);
    delete llmRequest.toolsDict[name];
    llmRequest.toolsDict[adapted.name] = adapted;
    logger.debug(`Adapted tool ${name} to ${adapted.name}`);
  }

  /** Initializes the driver and builds one tool per non-excluded action. */
  private async createTools(): Promise<ComputerUseTool[]> {
    await this.computer.initialize();
    const screenSize = await this.computer.screenSize();
    return Object.values(ACTIONS)
      .filter(
        (action) => !this.excludedPredefinedFunctions?.includes(action.name),
      )
      .map((action) => this.toolFor(action, screenSize));
  }

  /** Builds the tool that runs `action` against the driver. */
  private toolFor(
    action: ComputerAction,
    screenSize: readonly [number, number],
  ): ComputerUseTool {
    return new ComputerUseTool({
      name: action.name,
      description: action.description,
      screenSize,
      invoke: async (args, toolContext) => {
        await this.computer.prepare(toolContext);
        if (action.name === NAVIGATE_ACTION) {
          const refusal = await this.refuseUnsafeUrl(args['url']);
          if (refusal) {
            return refusal;
          }
        }
        return action.run(action.parameters.parse(args), this.computer);
      },
    });
  }

  /**
   * The payload to report instead of navigating, or `undefined` when the url
   * is safe to hand to the browser.
   */
  private async refuseUnsafeUrl(
    url: unknown,
  ): Promise<{error: string; url?: string} | undefined> {
    if (await this.isUrlAllowed(url)) {
      return undefined;
    }
    // The url is model-authored, so it is not echoed into the log.
    logger.warn('Refusing navigate(): url failed safety validation.');
    // The computer-use model rejects a function response carrying no url, so
    // report the page the browser is on.
    const state = await this.computer.currentState();
    return {error: URL_REFUSED_ERROR, url: state.url};
  }

  /**
   * Whether `url` is a public http(s) target the browser may be sent to.
   *
   * The shape checks are decided before any DNS lookup, and
   * `allowPrivateNetworkAccess` short-circuits before it, so an opted-in
   * caller resolves nothing.
   */
  private async isUrlAllowed(url: unknown): Promise<boolean> {
    if (typeof url !== 'string' || hasBackslashInAuthority(url)) {
      return false;
    }
    try {
      const target = parseRequestTarget(url);
      if (this.allowPrivateNetworkAccess) {
        return true;
      }
      if (isBlockedHostname(target.hostname)) {
        return false;
      }
      await assertPubliclyRoutable(target.hostname);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Maps the driver's environment onto the API's. Anything other than
 * `ENVIRONMENT_UNSPECIFIED` — including a value outside the enum — is a
 * browser, matching adk-python's `getattr` fallback.
 */
function toGenaiEnvironment(environment: ComputerEnvironment): Environment {
  return environment === ComputerEnvironment.ENVIRONMENT_UNSPECIFIED
    ? Environment.ENVIRONMENT_UNSPECIFIED
    : Environment.ENVIRONMENT_BROWSER;
}
