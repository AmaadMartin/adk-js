/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Environment, Tool} from '@google/genai';
import {z} from 'zod';

import {Context} from '../../agents/context.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {LlmRequest} from '../../models/llm_request.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {
  assertHostnameAllowed,
  assertResolvedAddressesAllowed,
  normalizeHost,
  parseAllowedUrl,
} from '../../utils/url_safety_utils.js';
import {BaseToolset} from '../base_toolset.js';
import {
  BaseComputer,
  ComputerActionName,
  ComputerEnvironment,
  ComputerState,
} from './base_computer.js';
import {ComputerUseTool, isComputerUseTool} from './computer_use_tool.js';

/** Returned to the model when `navigate` refuses a url. */
export const URL_REFUSED_ERROR =
  'navigate refused: url must be http(s) and must not target a private or link-local address.';

const directionSchema = z
  .enum(['up', 'down', 'left', 'right'])
  .describe('The direction to scroll.');

const xSchema = z.number().describe('The x-coordinate.');
const ySchema = z.number().describe('The y-coordinate.');

const navigateSchema = z.object({
  url: z.string().describe('The URL to navigate to.'),
});

/**
 * Maps the driver's environment onto the genai enum. Anything other than
 * `ENVIRONMENT_UNSPECIFIED` resolves to the browser, which covers both
 * `ENVIRONMENT_BROWSER` and a value outside the enum — Python's `getattr`
 * default.
 */
function toGenAiEnvironment(environment: ComputerEnvironment): Environment {
  return environment === ComputerEnvironment.ENVIRONMENT_UNSPECIFIED
    ? Environment.ENVIRONMENT_UNSPECIFIED
    : Environment.ENVIRONMENT_BROWSER;
}

/**
 * One predefined Gemini computer-use function: its wire contract, and how to
 * run it against a {@link BaseComputer}.
 */
interface ComputerAction {
  /** The wire name. Must match Gemini's predefined function exactly. */
  readonly name: string;
  readonly description: string;
  /** The declared arguments, keyed by their wire (snake_case) names. */
  readonly parameters: z.ZodObject<z.ZodRawShape>;
  invoke(
    computer: BaseComputer,
    args: Record<string, unknown>,
  ): Promise<ComputerState>;
}

/**
 * Builds one action entry, validating the model's arguments against the
 * declared schema before they reach the driver.
 */
function defineAction<TShape extends z.ZodRawShape>(action: {
  name: string;
  description: string;
  parameters: z.ZodObject<TShape>;
  invoke(
    computer: BaseComputer,
    args: z.infer<z.ZodObject<TShape>>,
  ): Promise<ComputerState>;
}): ComputerAction {
  return {
    name: action.name,
    description: action.description,
    parameters: action.parameters,
    invoke: (computer, args) =>
      action.invoke(computer, action.parameters.parse(args)),
  };
}

/**
 * The model-facing action space.
 *
 * Python discovers this by reflecting over `dir(BaseComputer)`. TypeScript has
 * no runtime signatures, so the table is explicit. Keying it by
 * {@link ComputerActionName} keeps it exhaustive: an action added to
 * `BaseComputer` fails to compile until it is listed here.
 */
const COMPUTER_ACTIONS: Readonly<Record<ComputerActionName, ComputerAction>> = {
  openWebBrowser: defineAction({
    name: 'open_web_browser',
    description: 'Opens the web browser.',
    parameters: z.object({}),
    invoke: (computer) => computer.openWebBrowser(),
  }),
  clickAt: defineAction({
    name: 'click_at',
    description:
      "Clicks at a specific x, y coordinate on the webpage. The 'x' and 'y' values are absolute values, scaled to the height and width of the screen.",
    parameters: z.object({x: xSchema, y: ySchema}),
    invoke: (computer, args) => computer.clickAt(args),
  }),
  hoverAt: defineAction({
    name: 'hover_at',
    description:
      "Hovers at a specific x, y coordinate on the webpage. May be used to explore sub-menus that appear on hover. The 'x' and 'y' values are absolute values, scaled to the height and width of the screen.",
    parameters: z.object({x: xSchema, y: ySchema}),
    invoke: (computer, args) => computer.hoverAt(args),
  }),
  typeTextAt: defineAction({
    name: 'type_text_at',
    description:
      "Types text at a specific x, y coordinate. The system automatically presses ENTER after typing. To disable this, set `press_enter` to false. The system automatically clears any existing content before typing the specified `text`. To disable this, set `clear_before_typing` to false. The 'x' and 'y' values are absolute values, scaled to the height and width of the screen.",
    parameters: z.object({
      x: xSchema,
      y: ySchema,
      text: z.string().describe('The text to type.'),
      press_enter: z
        .boolean()
        .optional()
        .describe('Whether to press ENTER after typing.'),
      clear_before_typing: z
        .boolean()
        .optional()
        .describe('Whether to clear existing content before typing.'),
    }),
    invoke: (computer, args) =>
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
    parameters: z.object({direction: directionSchema}),
    invoke: (computer, args) => computer.scrollDocument(args),
  }),
  scrollAt: defineAction({
    name: 'scroll_at',
    description:
      "Scrolls up, down, right, or left at a x, y coordinate by magnitude. The 'x' and 'y' values are absolute values, scaled to the height and width of the screen.",
    parameters: z.object({
      x: xSchema,
      y: ySchema,
      direction: directionSchema,
      magnitude: z.number().describe('The amount to scroll.'),
    }),
    invoke: (computer, args) => computer.scrollAt(args),
  }),
  wait: defineAction({
    name: 'wait',
    description:
      'Waits for n seconds to allow unfinished webpage processes to complete.',
    parameters: z.object({
      seconds: z.number().describe('The number of seconds to wait.'),
    }),
    invoke: (computer, args) => computer.wait(args),
  }),
  goBack: defineAction({
    name: 'go_back',
    description:
      'Navigates back to the previous webpage in the browser history.',
    parameters: z.object({}),
    invoke: (computer) => computer.goBack(),
  }),
  goForward: defineAction({
    name: 'go_forward',
    description:
      'Navigates forward to the next webpage in the browser history.',
    parameters: z.object({}),
    invoke: (computer) => computer.goForward(),
  }),
  search: defineAction({
    name: 'search',
    description:
      "Directly jumps to a search engine home page. Used when you need to start with a search. For example, this is used when the current website doesn't have the information needed or because a new task is being started.",
    parameters: z.object({}),
    invoke: (computer) => computer.search(),
  }),
  navigate: defineAction({
    name: 'navigate',
    description: 'Navigates directly to a specified URL.',
    parameters: navigateSchema,
    invoke: (computer, args) => computer.navigate(args),
  }),
  keyCombination: defineAction({
    name: 'key_combination',
    description:
      'Presses keyboard keys and combinations, such as "control+c" or "enter".',
    parameters: z.object({
      keys: z
        .array(z.string())
        .describe('List of keys to press in combination.'),
    }),
    invoke: (computer, args) => computer.keyCombination(args),
  }),
  dragAndDrop: defineAction({
    name: 'drag_and_drop',
    description:
      "Drag and drop an element from a x, y coordinate to a destination destination_y, destination_x coordinate. The 'x', 'y', 'destination_y' and 'destination_x' values are absolute values, scaled to the height and width of the screen.",
    parameters: z.object({
      x: xSchema,
      y: ySchema,
      destination_x: z.number().describe('The x-coordinate to drop at.'),
      destination_y: z.number().describe('The y-coordinate to drop at.'),
    }),
    invoke: (computer, args) =>
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
    parameters: z.object({}),
    invoke: (computer) => computer.currentState(),
  }),
};

const ACTIONS_BY_WIRE_NAME: ReadonlyMap<string, ComputerAction> = new Map(
  Object.values(COMPUTER_ACTIONS).map((action) => [action.name, action]),
);

/** Options for {@link ComputerUseToolset}. */
export interface ComputerUseToolsetOptions {
  /** The environment driver the model acts through. */
  computer: BaseComputer;
  /**
   * Wire names to withhold from the model. Also forwarded to the API as
   * `ComputerUse.excludedPredefinedFunctions`.
   */
  excludedPredefinedFunctions?: string[];
  /**
   * Lets `navigate` reach hosts that are not publicly routable. Off by
   * default: a model-supplied url is the one place an untrusted string becomes
   * a request from inside your network. Turn it on to drive a local dev server.
   */
  allowPrivateNetworkAccess?: boolean;
}

/** Options for {@link ComputerUseToolset.adaptComputerUseTool}. */
export interface AdaptComputerUseToolOptions {
  /** The existing wire name to replace, e.g. `'wait'`. */
  name: string;
  /** The request whose `toolsDict` holds the registered tool. */
  llmRequest: LlmRequest;
  /**
   * Builds the replacement. Read `tool.screenSize` and
   * `tool.virtualScreenSize` off the original and pass them on, so the
   * replacement normalizes coordinates the same way.
   */
  adapt(tool: ComputerUseTool): ComputerUseTool | Promise<ComputerUseTool>;
}

/**
 * Checks a model-supplied url before `navigate` hands it to the browser, and
 * returns the refusal to send the model, or `undefined` when the url is safe.
 *
 * Refuses anything that is not a well-formed http(s) url, and — unless the
 * caller opted into private network access — anything whose host is
 * `localhost`-style or resolves to an address that is not globally routable.
 *
 * The refusal reports the page the browser is already on: the computer-use
 * model rejects a function response that carries no url.
 */
async function refuseUnsafeUrl(
  url: string,
  allowPrivateNetworkAccess: boolean,
  computer: BaseComputer,
): Promise<{error: string; url?: string} | undefined> {
  try {
    const parsed = parseAllowedUrl(url);
    if (!allowPrivateNetworkAccess) {
      const host = normalizeHost(parsed.hostname);
      assertHostnameAllowed(host);
      await assertResolvedAddressesAllowed(host);
    }
    return undefined;
  } catch {
    logger.warn('Refusing navigate(): url failed safety validation.');
    const state = await computer.currentState();
    return {error: URL_REFUSED_ERROR, url: state.url};
  }
}

/**
 * Exposes a {@link BaseComputer} to the model as the Gemini computer-use
 * action space.
 *
 * The toolset builds one {@link ComputerUseTool} per predefined function and
 * attaches the `Tool.computerUse` config to the outgoing request, which is what
 * makes the API populate the function declarations. It does not declare them
 * itself.
 */
@experimental
export class ComputerUseToolset extends BaseToolset {
  private readonly computer: BaseComputer;
  private readonly excludedPredefinedFunctions?: string[];
  private readonly allowPrivateNetworkAccess: boolean;
  private tools?: Promise<ComputerUseTool[]>;

  constructor(options: ComputerUseToolsetOptions) {
    super([]);
    this.computer = options.computer;
    this.excludedPredefinedFunctions = options.excludedPredefinedFunctions;
    this.allowPrivateNetworkAccess = options.allowPrivateNetworkAccess ?? false;
  }

  override getTools(
    _readonlyContext?: ReadonlyContext,
  ): Promise<ComputerUseTool[]> {
    // Memoizing the promise rather than the resolved array keeps
    // `computer.initialize()` to one call even when callers race.
    this.tools ??= this.buildTools();
    return this.tools;
  }

  private async buildTools(): Promise<ComputerUseTool[]> {
    await this.computer.initialize();
    const screenSize = await this.computer.screenSize();

    return Object.values(COMPUTER_ACTIONS)
      .filter(
        (action) => !this.excludedPredefinedFunctions?.includes(action.name),
      )
      .map((action) => this.buildTool(action, screenSize));
  }

  private buildTool(
    action: ComputerAction,
    screenSize: [number, number],
  ): ComputerUseTool {
    return new ComputerUseTool({
      name: action.name,
      description: action.description,
      parameters: action.parameters,
      screenSize,
      invoke: async (args, toolContext) => {
        await this.computer.prepare(toolContext);
        return this.invokeAction(action, args);
      },
    });
  }

  /**
   * Runs one action against the driver. `navigate` is checked first, because
   * it is the one action that turns a model-supplied string into a request
   * from inside the caller's network.
   */
  private async invokeAction(
    action: ComputerAction,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (action === COMPUTER_ACTIONS.navigate) {
      const refusal = await refuseUnsafeUrl(
        navigateSchema.parse(args).url,
        this.allowPrivateNetworkAccess,
        this.computer,
      );
      if (refusal) {
        return refusal;
      }
    }
    return action.invoke(this.computer, args);
  }

  override async close(): Promise<void> {
    await this.computer.close();
  }

  override async processLlmRequest(
    _toolContext: Context,
    llmRequest: LlmRequest,
  ): Promise<void> {
    for (const tool of await this.getTools()) {
      llmRequest.toolsDict[tool.name] = tool;
    }

    llmRequest.config ??= {};
    llmRequest.config.tools ??= [];

    for (const tool of llmRequest.config.tools) {
      if ('computerUse' in tool && tool.computerUse) {
        logger.debug('Computer use already configured in LLM request');
        return;
      }
    }

    const environment = await this.computer.environment();
    const computerUseTool: Tool = {
      computerUse: {
        environment: toGenAiEnvironment(environment),
        excludedPredefinedFunctions: this.excludedPredefinedFunctions,
      },
    };
    llmRequest.config.tools.push(computerUseTool);

    logger.debug(
      `Added computer use tool with environment: ${environment}, excluded_functions: ${this.excludedPredefinedFunctions}`,
    );
  }

  /**
   * Replaces a registered computer-use tool with a modified one, for example
   * to bake a fixed argument into a zero-argument variant.
   *
   * Unlike Python, which reads the new name off `adapted_func.__name__`, the
   * replacement carries its own name: `Function.name` in JavaScript depends on
   * how the function was assigned and does not survive minification.
   *
   * An unknown action name, or one absent from `toolsDict`, is a no-op.
   */
  static async adaptComputerUseTool(
    options: AdaptComputerUseToolOptions,
  ): Promise<void> {
    const {name, llmRequest, adapt} = options;
    if (!ACTIONS_BY_WIRE_NAME.has(name)) {
      logger.warn(`${name} is not a predefined computer use function`);
      return;
    }

    const original = llmRequest.toolsDict[name];
    if (!isComputerUseTool(original)) {
      logger.warn(`${name} not found in toolsDict`);
      return;
    }

    const adapted = await adapt(original);
    delete llmRequest.toolsDict[name];
    llmRequest.toolsDict[adapted.name] = adapted;
    logger.debug(`Adapted computer use tool ${name} to ${adapted.name}`);
  }
}
