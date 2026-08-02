/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseToolset, ToolPredicate} from '../../tools/base_toolset.js';
import {experimental} from '../../utils/experimental.js';
import {cleanupPublisherClients} from './client.js';
import {EventarcCredentialsConfig, EventarcToolConfig} from './config.js';
import {createPublishMessageTool} from './message_tool.js';

export {
  CLOUD_PLATFORM_SCOPE,
  DEFAULT_PUBLISH_TIMEOUT_MS,
  type EventarcCredentialsConfig,
  type EventarcToolConfig,
} from './config.js';
export {
  publishMessage,
  type PublishMessageOptions,
  type PublishMessageResult,
} from './message_tool.js';

/** Arguments accepted by the {@link EventarcToolset} constructor. */
export interface EventarcToolsetOptions {
  toolConfig?: EventarcToolConfig;
  credentialsConfig?: EventarcCredentialsConfig;
  toolFilter?: ToolPredicate | string[];
  prefix?: string;
}

/**
 * Toolset for publishing CloudEvents to Google Cloud Eventarc Advanced.
 *
 * Exposes the generic `publish_message` tool, which lets the model supply
 * every CloudEvent attribute itself.
 */
@experimental
export class EventarcToolset extends BaseToolset {
  readonly toolConfig: EventarcToolConfig;
  readonly credentialsConfig: EventarcCredentialsConfig;

  private readonly tools: BaseTool[];

  constructor(options: EventarcToolsetOptions = {}) {
    super(options.toolFilter ?? [], options.prefix);
    this.toolConfig = options.toolConfig ?? {};
    this.credentialsConfig = options.credentialsConfig ?? {};
    this.tools = [
      createPublishMessageTool({
        toolConfig: this.toolConfig,
        credentialsConfig: this.credentialsConfig,
      }),
    ];
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    if (!context) {
      return [...this.tools];
    }
    return this.tools.filter((tool) => this.isToolSelected(tool, context));
  }

  override async close(): Promise<void> {
    return cleanupPublisherClients();
  }
}
