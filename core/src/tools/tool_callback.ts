/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {BaseTool} from './base_tool.js';

/**
 * A callback that runs before a tool is called.
 *
 * @param params.tool The tool to be called.
 * @param params.args The arguments to the tool.
 * @param params.context Context for the tool call.
 * @returns The tool response. When present, the returned tool response will
 *     be used and the framework will skip calling the actual tool.
 */
export type SingleBeforeToolCallback = (params: {
  tool: BaseTool;
  args: Record<string, unknown>;
  context: Context;
}) =>
  | Record<string, unknown>
  | undefined
  | Promise<Record<string, unknown> | undefined>;

/**
 * A single callback or a list of callbacks.
 *
 * When a list of callbacks is provided, the callbacks will be called in the
 * order they are listed until a callback does not return None.
 */
export type BeforeToolCallback =
  | SingleBeforeToolCallback
  | SingleBeforeToolCallback[];

/**
 * A callback that runs after a tool is called.
 *
 * @param params.tool The tool to be called.
 * @param params.args The arguments to the tool.
 * @param params.context Context for the tool call.
 * @param params.response The response from the tool.
 * @returns When present, the returned record will be used as tool result.
 */
export type SingleAfterToolCallback = (params: {
  tool: BaseTool;
  args: Record<string, unknown>;
  context: Context;
  response: Record<string, unknown>;
}) =>
  | Record<string, unknown>
  | undefined
  | Promise<Record<string, unknown> | undefined>;

/**
 * A single callback or a list of callbacks.
 *
 * When a list of callbacks is provided, the callbacks will be called in the
 * order they are listed until a callback does not return None.
 */
export type AfterToolCallback =
  | SingleAfterToolCallback
  | SingleAfterToolCallback[];

/**
 * Unified configuration options for executing tools.
 */
export interface ToolExecutionConfig {
  toolsDict: Record<string, BaseTool>;
  beforeToolCallbacks?: SingleBeforeToolCallback[];
  afterToolCallbacks?: SingleAfterToolCallback[];
}
