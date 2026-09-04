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
import {PubSubToolConfig} from './config.js';
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
 * One identity for every end user, from Application Default Credentials:
 *
 * ```ts
 * const authClient = await new GoogleAuth({
 *   scopes: [...PUBSUB_DEFAULT_SCOPES],
 * }).getClient();
 * const toolset = new PubSubToolset({credentialsConfig: {authClient}});
 * ```
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
   * @throws Error if `credentialsConfig` names no credential source or more
   *   than one.
   */
  constructor(options: PubSubToolsetOptions) {
    // `BaseToolset` requires a filter, so an absent one becomes a predicate
    // that selects everything. That keeps "no filter" distinct from the empty
    // array, which adk-python reads as "expose nothing".
    super(options.toolFilter ?? (() => true));
    validatePubSubCredentialsConfig(options.credentialsConfig);
    const credentials = new PubSubCredentialsManager(options.credentialsConfig);
    const settings = options.pubsubToolConfig ?? {};
    this.tools = [
      createPublishMessageTool(credentials, settings),
      createPullMessagesTool(credentials, settings),
      createAcknowledgeMessagesTool(credentials, settings),
    ];
  }

  /**
   * Selects a tool the way adk-python's `PubSubToolset._is_tool_selected`
   * does: a name the list carries selects the tool, and an empty list selects
   * none. The inherited version reads an empty list as "no filter" and would
   * expose every tool instead.
   */
  protected override isToolSelected(
    tool: BaseTool,
    context: ReadonlyContext,
  ): boolean {
    const filter = this.toolFilter;
    return Array.isArray(filter)
      ? filter.includes(tool.name)
      : filter(tool, context);
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    if (context) {
      return this.tools.filter((tool) => this.isToolSelected(tool, context));
    }
    // A predicate needs a context, so without one only a name filter applies.
    // `OpenAPIToolset` returns every tool in the same situation.
    const filter = this.toolFilter;
    return Array.isArray(filter)
      ? this.tools.filter((tool) => filter.includes(tool.name))
      : this.tools;
  }

  /** Closes every cached Pub/Sub client. Calling it twice is safe. */
  override close(): Promise<void> {
    return cleanupClients();
  }
}
