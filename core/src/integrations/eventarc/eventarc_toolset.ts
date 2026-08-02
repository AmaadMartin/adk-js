/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseToolset, ToolPredicate} from '../../tools/base_toolset.js';
import {ToolInputParameters} from '../../tools/function_tool.js';
import {experimental} from '../../utils/experimental.js';
import {cleanupPublisherClients} from './client.js';
import {EventarcCredentialsConfig, EventarcToolConfig} from './config.js';
import {
  AttributeBinding,
  buildDomainSpecificTool,
  CloudEventAttributesBinding,
} from './domain_specific_publish.js';
import {createPublishMessageTool} from './message_tool.js';

export {
  CLOUD_PLATFORM_SCOPE,
  DEFAULT_PUBLISH_TIMEOUT_MS,
  type EventarcCredentialsConfig,
  type EventarcToolConfig,
} from './config.js';
export {
  AgentProvided,
  isAgentProvided,
  isUnspecified,
  MISSING,
  OMIT,
  type AgentProvidedBinding,
  type AgentProvidedDefault,
  type AttributeBinding,
  type AttributeResolver,
  type CloudEventAttributesBinding,
  type CustomAttributeBinding,
  type MissingSentinel,
  type OmitSentinel,
  type OptionalAttributeBinding,
} from './domain_specific_publish.js';
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

/** Arguments accepted by {@link EventarcToolset.createPublishTool}. */
export interface CreatePublishToolOptions<TPayload = unknown> {
  /** Tool name exposed to the model. */
  name: string;
  /** Prompt-friendly description of what the tool publishes. */
  description: string;
  /** Message bus resource name, or a binding that resolves to one. */
  bus: AttributeBinding<TPayload>;
  /** Bindings for the CloudEvent attributes. */
  ceAttributesBinding: CloudEventAttributesBinding<TPayload>;
  /** Schema of the structured payload exposed to the model as `event_data`. */
  payloadSchema?: ToolInputParameters;
}

/**
 * Toolset for publishing CloudEvents to Google Cloud Eventarc Advanced.
 *
 * Always exposes the generic `publish_message` tool, plus any domain-specific
 * tool created with {@link EventarcToolset.createPublishTool}.
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

  /**
   * Creates a domain-specific publish tool and adds it to this toolset.
   *
   * Each CloudEvent attribute can be fixed by configuration, derived from the
   * payload, supplied by the model, or dropped entirely; that declaration
   * determines the parameter schema the model sees.
   */
  createPublishTool<TPayload = unknown>(
    options: CreatePublishToolOptions<TPayload>,
  ): BaseTool {
    const tool = buildDomainSpecificTool<TPayload>({
      ...options,
      toolConfig: this.toolConfig,
      credentialsConfig: this.credentialsConfig,
    });
    this.tools.push(tool);
    return tool;
  }

  override async close(): Promise<void> {
    return cleanupPublisherClients();
  }
}
