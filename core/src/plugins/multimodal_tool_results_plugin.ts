/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {cloneDeep, isEqual} from 'lodash-es';

import {Context} from '../agents/context.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {State} from '../sessions/state.js';
import {BaseTool} from '../tools/base_tool.js';
import {BasePlugin} from './base_plugin.js';

/** How long tool-returned parts stay attached to model requests. */
export type MultimodalToolResultsRetention = 'next_model_call' | 'session';

/**
 * The state key holding the parts that the next model call consumes, under the
 * default `'next_model_call'` retention.
 */
export const PARTS_RETURNED_BY_TOOLS_ID = 'temp:PARTS_RETURNED_BY_TOOLS_ID';

/**
 * The state key holding the parts that `'session'` retention re-attaches to
 * every later model request.
 *
 * The key is deliberately not `temp:`-prefixed. The session layer strips
 * `temp:` keys from an event's state delta before it persists the event, so a
 * `temp:` key cannot survive into a later turn.
 */
export const SESSION_PARTS_RETURNED_BY_TOOLS_ID =
  'multimodal_tool_results_plugin:PARTS_RETURNED_BY_TOOLS_ID';

/** The state key accumulating every part returned during the current turn. */
export const CURRENT_TURN_PARTS_ID =
  'temp:multimodal_tool_results_plugin:current_turn_parts';

/** The state key marking that this turn already replaced the session parts. */
export const SESSION_UPDATED_KEY =
  'temp:multimodal_tool_results_plugin:updated_in_invocation';

const DEFAULT_PLUGIN_NAME = 'multimodal_tool_results_plugin';

/** Own-property names a `@google/genai` `Part` can carry. */
const PART_KEYS: ReadonlySet<string> = new Set([
  'mediaResolution',
  'codeExecutionResult',
  'executableCode',
  'fileData',
  'functionCall',
  'functionResponse',
  'inlineData',
  'text',
  'thought',
  'thoughtSignature',
  'videoMetadata',
  'toolCall',
  'toolResponse',
  'partMetadata',
]);

/**
 * Structural type guard for a `@google/genai` `Part`.
 *
 * `Part` is an interface whose fields are all optional, so this guard is
 * necessarily heuristic. An object qualifies when it carries at least one
 * defined `Part` field and no field a `Part` does not have. A tool that returns
 * a plain result object shaped exactly like a `Part` (`{text: '...'}`) is
 * therefore treated as one.
 */
export function isPart(value: unknown): value is Part {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    keys.every((key) => PART_KEYS.has(key)) &&
    Object.values(value).some((field) => field !== undefined)
  );
}

/**
 * Type guard for a non-empty array of `Part`s. Only the first element is
 * checked, which matches adk-python.
 */
function isPartArray(value: unknown): value is Part[] {
  return Array.isArray(value) && value.length > 0 && isPart(value[0]);
}

/**
 * Returns the parts a tool result carries, or `undefined` when the result is
 * neither a `Part` nor a non-empty array of `Part`s.
 */
function extractParts(result: unknown): Part[] | undefined {
  if (isPart(result)) {
    return [result];
  }
  return isPartArray(result) ? [...result] : undefined;
}

/** Appends `parts` to the array held under `key`. */
function appendParts(state: State, key: string, parts: Part[]): void {
  state.set(key, [...(state.get<Part[]>(key) ?? []), ...parts]);
}

/**
 * Records `parts` for `'session'` retention: the first tool call of a turn
 * replaces the session parts, later ones accumulate.
 */
function saveSessionParts(state: State, parts: Part[]): void {
  // inlineData parts carry raw bytes, so they are one-shot and never reach the
  // persisted session key.
  const retained = parts.filter((part) => part.inlineData === undefined);
  if (retained.length > 0) {
    if (state.has(SESSION_UPDATED_KEY)) {
      appendParts(
        state,
        SESSION_PARTS_RETURNED_BY_TOOLS_ID,
        cloneDeep(retained),
      );
    } else {
      state.set(SESSION_UPDATED_KEY, true);
      state.set(SESSION_PARTS_RETURNED_BY_TOOLS_ID, cloneDeep(retained));
    }
  }
  appendParts(state, CURRENT_TURN_PARTS_ID, parts);
}

/** Drains the one-shot buffer and returns the parts to attach. */
function takeNextModelCallParts(state: State): Part[] {
  const parts = state.get<Part[]>(PARTS_RETURNED_BY_TOOLS_ID) ?? [];
  if (parts.length > 0) {
    state.set(PARTS_RETURNED_BY_TOOLS_ID, []);
  }
  return parts;
}

/**
 * Returns the session-retained parts followed by this turn's parts, and drains
 * the turn buffer. A session part already present in this turn is dropped, so
 * it is attached once.
 */
function takeSessionParts(state: State): Part[] {
  const sessionParts =
    state.get<Part[]>(SESSION_PARTS_RETURNED_BY_TOOLS_ID) ?? [];
  const currentParts = state.get<Part[]>(CURRENT_TURN_PARTS_ID) ?? [];
  if (currentParts.length > 0) {
    state.set(CURRENT_TURN_PARTS_ID, []);
  }
  const unseen = sessionParts.filter(
    (part) => !currentParts.some((current) => isEqual(current, part)),
  );
  return [...unseen, ...currentParts];
}

/**
 * Lets a function tool return multimodal content directly.
 *
 * A tool that returns a `Part` or an array of `Part`s normally has that value
 * stringified into the JSON function response, so the model never sees the
 * image, audio clip or file. This plugin buffers those parts as the tool
 * returns and appends them to the last content of the next model request, so
 * the model receives them as real parts. The tool result itself is left
 * unchanged.
 *
 * With `retention: 'session'` the parts stay attached for the rest of the
 * session. The session buffer holds the parts of the most recent turn that
 * returned any, and it grows with each tool call within that turn; there is no
 * cap, which matches adk-python.
 *
 * Should be removed in favor of directly supporting `FunctionResponsePart` when
 * these are supported outside of the computer use tool. For context see:
 * https://github.com/google/adk-python/issues/3064
 *
 * @example
 * ```typescript
 * const runner = new InMemoryRunner({
 *   agent,
 *   plugins: [new MultimodalToolResultsPlugin({retention: 'session'})],
 * });
 * ```
 */
export class MultimodalToolResultsPlugin extends BasePlugin {
  private readonly retention: MultimodalToolResultsRetention;

  /**
   * @param options.name The name of the plugin instance.
   * @param options.retention How long tool-returned parts stay attached to
   *     model requests. `'next_model_call'` (the default) attaches the saved
   *     parts once and then clears them. `'session'` keeps re-attaching the
   *     latest saved parts to every later model request of the session, so
   *     follow-up turns can still refer to them. Only `fileData` and `text`
   *     parts are retained across turns; `inlineData` parts are always
   *     one-shot.
   * @throws If `options.retention` is not a known retention mode.
   */
  constructor(
    options: {
      name?: string;
      retention?: MultimodalToolResultsRetention;
    } = {},
  ) {
    super(options.name ?? DEFAULT_PLUGIN_NAME);
    const retention = options.retention ?? 'next_model_call';
    if (retention !== 'next_model_call' && retention !== 'session') {
      throw new Error(
        `retention must be 'next_model_call' or 'session', got ${retention}`,
      );
    }
    this.retention = retention;
  }

  /**
   * Buffers the parts the tool returned, leaving the tool result unchanged.
   *
   * Always returns `undefined`, including for a result that carries no parts.
   * A plugin that returns a value stops `PluginManager` from running the
   * plugins after it and stops ADK from running the agent's own
   * `afterToolCallback`s, and this plugin never replaces a result.
   */
  override async afterToolCallback({
    toolContext,
    result,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    const parts = extractParts(result);
    if (!parts) {
      return undefined;
    }
    if (this.retention === 'session') {
      saveSessionParts(toolContext.state, parts);
    } else {
      appendParts(toolContext.state, PARTS_RETURNED_BY_TOOLS_ID, parts);
    }
    return undefined;
  }

  /**
   * Appends the buffered parts to the last content of the request. Never
   * short-circuits the model call.
   */
  override async beforeModelCallback({
    callbackContext,
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    if (llmRequest.contents.length === 0) {
      return undefined;
    }
    const {state} = callbackContext;
    const parts =
      this.retention === 'session'
        ? takeSessionParts(state)
        : takeNextModelCallParts(state);
    if (parts.length > 0) {
      const last = llmRequest.contents[llmRequest.contents.length - 1];
      last.parts = [...(last.parts ?? []), ...parts];
    }
    return undefined;
  }
}
