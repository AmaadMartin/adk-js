/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {cleanupClients} from './client.js';
import {
  createAcknowledgeMessagesTool,
  createPublishMessageTool,
  createPullMessagesTool,
} from './message_tool.js';
import {
  PubSubCredentialsConfig,
  PubSubCredentialsManager,
  validatePubSubCredentialsConfig,
} from './pubsub_credentials.js';

/**
 * Configuration for the Pub/Sub tools.
 *
 * adk-python declares this model with `extra='forbid'`. TypeScript's
 * excess-property check rejects an unknown field on an object literal at the
 * call site, so there is no runtime validator here. A value widened to
 * `PubSubToolConfig` before it is passed escapes that check.
 */
export interface PubSubToolConfig {
  /**
   * GCP project id to use for the Pub/Sub operations. When unset, the project
   * is inferred from the environment or from the credentials.
   */
  projectId?: string;
}

/** Options for {@link PubSubToolset}. */
export interface PubSubToolsetOptions {
  /**
   * How the tools authenticate. Required: Pub/Sub rejects an unauthenticated
   * call, so there is no working default.
   */
  credentialsConfig: PubSubCredentialsConfig;
  /** Which project the tools work in. Defaults to inferring it. */
  pubsubToolConfig?: PubSubToolConfig;
  /**
   * Names of the tools to expose, or a predicate over them. An empty array
   * exposes nothing; omit the option to expose everything.
   */
  toolFilter?: ToolPredicate | string[];
}

/**
 * Tools for publishing to Pub/Sub topics and reading Pub/Sub subscriptions.
 *
 * The tool names are:
 *   - `publish_message`
 *   - `pull_messages`
 *   - `acknowledge_messages`
 *
 * Every tool answers with plain fields on success and with
 * `{status: 'ERROR', error_details}` on failure, and never throws.
 *
 * Requires the optional peer dependency `@google-cloud/pubsub`, which is
 * loaded on the first tool call. Install it with
 * `npm install @google-cloud/pubsub`.
 *
 * `new PubSubToolset({credentialsConfig: {}})` uses Application Default
 * Credentials, which is one identity for every end user.
 *
 * An empty `toolFilter` array exposes no tools, which follows adk-python and
 * not `BaseToolset.isToolSelected`. The base class reads an empty array as
 * "no filter"; this toolset reads an absent option as "no filter" instead, so
 * both intentions stay expressible.
 */
@experimental
export class PubSubToolset extends BaseToolset {
  private readonly tools: BaseTool[];

  /**
   * @param options How the tools authenticate, and which of them to expose.
   * @throws Error if `credentialsConfig` names two credential sources, or
   *   half an OAuth client.
   */
  constructor(options: PubSubToolsetOptions) {
    // `BaseToolset` requires a filter, so an absent one becomes a predicate
    // that selects everything. That keeps "no filter" distinct from the empty
    // array, which adk-python reads as "expose nothing".
    super(options.toolFilter ?? (() => true));
    validatePubSubCredentialsConfig(options.credentialsConfig);
    const credentials = new PubSubCredentialsManager(options.credentialsConfig);
    const projectId = options.pubsubToolConfig?.projectId;
    this.tools = [
      createPublishMessageTool(credentials, projectId),
      createPullMessagesTool(credentials, projectId),
      createAcknowledgeMessagesTool(credentials, projectId),
    ];
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const filter = this.toolFilter;
    if (Array.isArray(filter)) {
      // A name the list carries selects the tool, and an empty list selects
      // none, as adk-python's `_is_tool_selected` does. The inherited version
      // reads an empty list as "no filter" and would expose every tool.
      return this.tools.filter((tool) => filter.includes(tool.name));
    }
    // A predicate needs a context, so without one every tool is exposed.
    // `OpenAPIToolset` does the same.
    return context
      ? this.tools.filter((tool) => filter(tool, context))
      : this.tools;
  }

  /** Closes every cached Pub/Sub client. Calling it twice is safe. */
  override close(): Promise<void> {
    return cleanupClients();
  }
}
