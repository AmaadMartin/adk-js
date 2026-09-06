/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The Eventarc toolset. */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseToolset, ToolPredicate} from '../../tools/base_toolset.js';
import {FunctionTool} from '../../tools/function_tool.js';
import {experimental} from '../../utils/experimental.js';
import {cleanupClients} from './client.js';
import type {EventarcCredentialsConfig, EventarcToolConfig} from './config.js';
import {publishMessage, publishMessageSchema} from './message_tool.js';

/** The name the model calls the publishing tool by. */
export const PUBLISH_MESSAGE_TOOL_NAME = 'publish_message';

const PUBLISH_MESSAGE_DESCRIPTION =
  'Publishes a structured CloudEvent to a Google Cloud Eventarc Advanced ' +
  'message bus, so that downstream subscribers receive it. Reports whether ' +
  'the bus accepted the event, not what a subscriber did with it.';

/** How to build an {@link EventarcToolset}. */
export interface EventarcToolsetOptions {
  /** The project id and publish timeout. */
  toolConfig?: EventarcToolConfig;
  /** How the tools authenticate. Omit for Application Default Credentials. */
  credentialsConfig?: EventarcCredentialsConfig;
  /** Prepended to the tool name, as `<prefix>_publish_message`. */
  prefix?: string;
  /** Which tools to expose to the model. */
  toolFilter?: ToolPredicate | string[];
}

/**
 * Tools for publishing to Google Cloud Eventarc.
 *
 * The toolset exposes one tool, `publish_message`. Credentials and settings
 * are bound when the toolset builds the tool, so the model can neither see
 * nor supply them.
 *
 * ```ts
 * const toolset = new EventarcToolset({
 *   toolConfig: {projectId: 'my-project'},
 * });
 * const agent = new LlmAgent({
 *   name: 'event_publisher',
 *   model: 'gemini-2.5-flash',
 *   tools: [toolset],
 * });
 * ```
 *
 * Ported from `google/adk-python`
 * `integrations/eventarc/_eventarc_toolset.py::EventarcToolset`.
 */
@experimental
export class EventarcToolset extends BaseToolset {
  /** The project id and publish timeout the tools run with. */
  readonly toolConfig: EventarcToolConfig;
  /** How the tools authenticate. */
  readonly credentialsConfig: EventarcCredentialsConfig;

  private readonly tools: BaseTool[];

  constructor(options: EventarcToolsetOptions = {}) {
    super(options.toolFilter ?? [], options.prefix);
    this.toolConfig = options.toolConfig ?? {};
    this.credentialsConfig = options.credentialsConfig ?? {};

    const name = this.prefix
      ? `${this.prefix}_${PUBLISH_MESSAGE_TOOL_NAME}`
      : PUBLISH_MESSAGE_TOOL_NAME;
    this.tools = [
      new FunctionTool({
        name,
        description: PUBLISH_MESSAGE_DESCRIPTION,
        parameters: publishMessageSchema,
        execute: (input) =>
          publishMessage(input, {
            credentialsConfig: this.credentialsConfig,
            toolConfig: this.toolConfig,
          }),
      }),
    ];
  }

  /**
   * Returns the tools the model may call.
   *
   * @param context Context the tool filter is evaluated against. Without one,
   *     a predicate filter is not applied.
   * @return The selected tools.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.tools.filter((tool) => {
      if (Array.isArray(this.toolFilter) && this.toolFilter.length > 0) {
        return this.toolFilter.includes(tool.name);
      }
      if (context !== undefined) {
        return this.isToolSelected(tool, context);
      }
      return true;
    });
  }

  /** Closes every publisher client the tools opened. */
  override async close(): Promise<void> {
    await cleanupClients();
  }
}
