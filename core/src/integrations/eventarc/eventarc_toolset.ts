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
import type {EventarcToolConfig} from './config.js';
import {
  buildDomainSpecificTool,
  type CreatePublishToolOptions,
} from './domain_specific_publish.js';
import {
  validateEventarcCredentialsConfig,
  type EventarcCredentialsConfig,
} from './eventarc_credentials.js';
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
    validateEventarcCredentialsConfig(this.credentialsConfig);

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

  /**
   * Builds a publish tool with its CloudEvent attributes bound in advance,
   * adds it to the toolset, and returns it.
   *
   * Use it when the application already knows what it publishes and only the
   * payload, or a field or two, comes from the model.
   *
   * @param options What to bind and what to ask the model for.
   * @return The tool, already added to this toolset.
   * @throws {InputValidationError} If any binding is invalid.
   */
  createPublishTool(options: CreatePublishToolOptions): BaseTool {
    const tool = buildDomainSpecificTool(options, {
      credentialsConfig: this.credentialsConfig,
      toolConfig: this.toolConfig,
    });
    this.tools.push(tool);
    return tool;
  }

  /** Closes every publisher client the tools opened. */
  override async close(): Promise<void> {
    await cleanupClients();
  }
}
