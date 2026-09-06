/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';
import {isEqual} from 'lodash-es';

import {Context} from '../agents/context.js';
import {InputValidationError} from '../errors/input_validation_error.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {State} from '../sessions/state.js';
import {BaseTool} from '../tools/base_tool.js';

import {BasePlugin} from './base_plugin.js';

/**
 * The state key holding the parts that the next model request picks up.
 *
 * `temp:`-prefixed state is invocation-scoped and never persisted.
 */
export const PARTS_RETURNED_BY_TOOLS_ID = 'temp:PARTS_RETURNED_BY_TOOLS_ID';

/**
 * The state key holding the parts that survive into later turns.
 *
 * Deliberately not `temp:`-prefixed: the session layer strips `temp:` keys
 * before it persists an event, and `'session'` retention needs the saved parts
 * to outlive the invocation that produced them.
 */
export const SESSION_PARTS_RETURNED_BY_TOOLS_ID =
  'multimodal_tool_results_plugin:PARTS_RETURNED_BY_TOOLS_ID';

/** The state key holding every part produced by the current invocation. */
export const CURRENT_TURN_PARTS_ID =
  'temp:multimodal_tool_results_plugin:current_turn_parts';

/**
 * The state key marking that the current invocation already replaced the
 * session-scoped parts, so later tool calls in the same turn append instead.
 */
export const SESSION_UPDATED_KEY =
  'temp:multimodal_tool_results_plugin:updated_in_invocation';

/** How long tool-returned parts stay attached to model requests. */
export type MultimodalToolResultsRetention = 'next_model_call' | 'session';

/** Options for {@link MultimodalToolResultsPlugin}. */
export interface MultimodalToolResultsPluginOptions {
  /**
   * The name of the plugin instance. Defaults to
   * `'multimodal_tool_results_plugin'`.
   */
  name?: string;
  /** Defaults to `'next_model_call'`. */
  retention?: MultimodalToolResultsRetention;
}

/**
 * Every field `@google/genai` declares on `Part`.
 *
 * `Part` is a structural interface with no runtime class, so a value is treated
 * as a part when it sets at least one of these fields.
 */
const PART_FIELDS: ReadonlyArray<keyof Part> = [
  'codeExecutionResult',
  'executableCode',
  'fileData',
  'functionCall',
  'functionResponse',
  'inlineData',
  'mediaResolution',
  'partMetadata',
  'text',
  'thought',
  'thoughtSignature',
  'toolCall',
  'toolResponse',
  'videoMetadata',
];

function isPart(value: unknown): value is Part {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Part;
  return PART_FIELDS.some((field) => candidate[field] !== undefined);
}

/**
 * Returns the parts a tool returned, or `undefined` when it returned something
 * else.
 *
 * Only the first element of an array is checked, matching adk-python.
 */
function extractParts(result: unknown): Part[] | undefined {
  if (isPart(result)) {
    return [result];
  }
  if (Array.isArray(result) && result.length > 0 && isPart(result[0])) {
    return [...result];
  }
  return undefined;
}

/**
 * Returns the part as it would come back from a JSON session round trip.
 *
 * Dropping `undefined`-valued keys is what lets a stored part compare equal to
 * the live part it was made from.
 */
function toJsonPart(part: Part): Part {
  return JSON.parse(JSON.stringify(part)) as Part;
}

function appendParts(state: State, key: string, parts: readonly Part[]): void {
  state.set(key, [...(state.get<Part[]>(key) ?? []), ...parts]);
}

function attachParts(content: Content, parts: readonly Part[]): void {
  if (parts.length === 0) {
    return;
  }
  content.parts = [...(content.parts ?? []), ...parts];
}

/**
 * A plugin that lets a function tool return `Part` values directly.
 *
 * A tool normally returns a JSON-serialisable object, which the model sees as a
 * stringified function response. With this plugin registered, a tool may return
 * a single `Part` or a `Part[]` instead, and the plugin attaches those parts to
 * the next model request as real content parts. Use it for a tool that fetches
 * a file, an image, or audio that the model should read as media.
 *
 * Should be removed in favour of directly supporting a function response part
 * once those are supported outside the computer use tool.
 *
 * Example:
 * ```typescript
 * const runner = new InMemoryRunner({
 *   agent,
 *   plugins: [new MultimodalToolResultsPlugin()],
 * });
 * ```
 */
export class MultimodalToolResultsPlugin extends BasePlugin {
  private readonly retention: MultimodalToolResultsRetention;

  /**
   * @param options The plugin options.
   * @throws {InputValidationError} If `retention` is neither
   *     `'next_model_call'` nor `'session'`.
   */
  constructor(options: MultimodalToolResultsPluginOptions = {}) {
    const {
      name = 'multimodal_tool_results_plugin',
      retention = 'next_model_call',
    } = options;
    if (retention !== 'next_model_call' && retention !== 'session') {
      throw new InputValidationError(
        `retention must be 'next_model_call' or 'session', got ${retention}`,
      );
    }
    super(name);
    this.retention = retention;
  }

  /**
   * Saves the parts a tool returned so that a later model request can pick
   * them up.
   *
   * @returns `undefined` when the result is parts, so the tool's own response
   *     stands; the unchanged result otherwise.
   */
  override async afterToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: unknown;
  }): Promise<Record<string, unknown> | undefined> {
    const parts = extractParts(params.result);
    if (!parts) {
      // Mirrors adk-python: the tool's own result is handed back unchanged.
      // `normalizeCallbackResponse` in `agents/functions.ts` accepts any value,
      // so the declared record type is narrower than what actually flows here.
      return params.result as Record<string, unknown>;
    }

    const state = params.toolContext.state;
    if (this.retention !== 'session') {
      appendParts(state, PARTS_RETURNED_BY_TOOLS_ID, parts);
      return;
    }

    const sessionParts = parts.filter((part) => part.inlineData === undefined);
    if (sessionParts.length > 0) {
      const serialized = sessionParts.map(toJsonPart);
      if (state.has(SESSION_UPDATED_KEY)) {
        appendParts(state, SESSION_PARTS_RETURNED_BY_TOOLS_ID, serialized);
      } else {
        state.set(SESSION_UPDATED_KEY, true);
        state.set(SESSION_PARTS_RETURNED_BY_TOOLS_ID, serialized);
      }
    }
    appendParts(state, CURRENT_TURN_PARTS_ID, parts);
    return;
  }

  /** Attaches the saved parts to the last content of the model request. */
  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const {contents} = params.llmRequest;
    if (contents.length === 0) {
      return;
    }

    const state = params.callbackContext.state;
    const lastContent = contents[contents.length - 1];

    if (this.retention !== 'session') {
      const saved = state.get<Part[]>(PARTS_RETURNED_BY_TOOLS_ID) ?? [];
      if (saved.length > 0) {
        attachParts(lastContent, saved);
        state.set(PARTS_RETURNED_BY_TOOLS_ID, []);
      }
      return;
    }

    const sessionParts =
      state.get<Part[]>(SESSION_PARTS_RETURNED_BY_TOOLS_ID) ?? [];
    const currentParts = state.get<Part[]>(CURRENT_TURN_PARTS_ID) ?? [];
    const currentJson = currentParts.map(toJsonPart);
    const unseenSessionParts = sessionParts.filter(
      (saved) => !currentJson.some((current) => isEqual(current, saved)),
    );

    if (currentParts.length > 0) {
      state.set(CURRENT_TURN_PARTS_ID, []);
    }
    attachParts(lastContent, [...unseenSessionParts, ...currentParts]);
    return;
  }
}
