/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';

import {BaseAgent} from '../agents/base_agent.js';
import {Context} from '../agents/context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {BaseTool} from '../tools/base_tool.js';
import {logger} from '../utils/logger.js';
import {safeSerializeRecord} from '../utils/redact_secrets.js';

import {BasePlugin} from './base_plugin.js';
import {
  DebugEntryType,
  InvocationDebugState,
  serializeContent,
  serializeEvent,
  serializeLlmResponse,
  serializeRequestConfig,
  toDocument,
} from './debug_logging_serializers.js';

export {DebugEntryType} from './debug_logging_serializers.js';

/** Default name of a {@link DebugLoggingPlugin} instance. */
const DEFAULT_PLUGIN_NAME = 'debug_logging_plugin';

/**
 * Default path of the debug output file, resolved against the working
 * directory of the process.
 */
export const DEFAULT_DEBUG_OUTPUT_PATH = 'adk_debug.yaml';

/**
 * Default number of in-flight invocations held in memory before the oldest is
 * flushed and dropped.
 */
const DEFAULT_MAX_BUFFERED_INVOCATIONS = 64;

/**
 * Mode for a debug file this plugin creates: readable and writable by its
 * owner only. The file holds whole prompts and responses.
 */
const OUTPUT_FILE_MODE = 0o600;

/** The group and other permission bits of a file mode. */
const GROUP_AND_OTHER_MODE_BITS = 0o077;

/** Longest line js-yaml emits before it wraps. */
const YAML_LINE_WIDTH = 120;

/** js-yaml writes no document separator of its own. */
const DOCUMENT_SEPARATOR = '---\n';

/** Options for {@link DebugLoggingPlugin}. */
export interface DebugLoggingPluginOptions {
  /** The name of the plugin instance. */
  name?: string;
  /**
   * Path of the output file. A relative path resolves against the working
   * directory of the process. Defaults to
   * {@link DEFAULT_DEBUG_OUTPUT_PATH}.
   */
  outputPath?: string;
  /** Whether to record a session state snapshot. Defaults to `true`. */
  includeSessionState?: boolean;
  /**
   * Whether to record the full system instruction rather than only its
   * length. Defaults to `true`.
   */
  includeSystemInstruction?: boolean;
  /**
   * How many in-flight invocations to hold in memory. An invocation that never
   * completes is never pruned by `afterRunCallback`, so the oldest buffered
   * invocation is flushed and dropped once this many are held. Defaults to 64.
   */
  maxBufferedInvocations?: number;
}

/**
 * A plugin that captures a complete debug record of every invocation to a
 * file.
 *
 * It records the LLM requests and responses, the tool calls and their results,
 * the events the runner yields, and the session state at the end of each
 * invocation. Each invocation is appended to the file as its own YAML
 * document, separated by `---`, so the whole file loads with a multi-document
 * YAML loader.
 *
 * Credentials are redacted, but the file still holds whole prompts and
 * responses, so a file this plugin creates is readable by its owner only and
 * is not safe to hand around. The file grows for the life of the process; the
 * plugin does not rotate or cap it.
 *
 * Redaction covers a value whose shape identifies it as a credential wherever
 * it appears, a mapping key that names a secret with the `app:` or `user:`
 * state scope stripped first, an armored private key block found inside any
 * string, and every `temp:`-prefixed state key. That last rule blanks all
 * temporary state, not only credentials, so an intermediate value passed
 * between agents under a `temp:` key reads as `[REDACTED]` here.
 *
 * Example:
 * ```typescript
 * const app = new App({
 *   name: 'my_app',
 *   rootAgent: agent,
 *   plugins: [new DebugLoggingPlugin({outputPath: '/tmp/adk_debug.yaml'})],
 * });
 * ```
 */
export class DebugLoggingPlugin extends BasePlugin {
  /** Where the plugin appends its documents. */
  readonly outputPath: string;
  readonly includeSessionState: boolean;
  readonly includeSystemInstruction: boolean;
  private readonly maxBufferedInvocations: number;
  private readonly invocationStates = new Map<string, InvocationDebugState>();
  private warnedAboutOutputMode = false;

  constructor(options: DebugLoggingPluginOptions = {}) {
    super(options.name ?? DEFAULT_PLUGIN_NAME);
    this.outputPath = options.outputPath ?? DEFAULT_DEBUG_OUTPUT_PATH;
    this.includeSessionState = options.includeSessionState ?? true;
    this.includeSystemInstruction = options.includeSystemInstruction ?? true;
    this.maxBufferedInvocations =
      options.maxBufferedInvocations ?? DEFAULT_MAX_BUFFERED_INVOCATIONS;
  }

  override async onUserMessageCallback({
    invocationContext,
    userMessage,
  }: {
    invocationContext: InvocationContext;
    userMessage: Content;
  }): Promise<Content | undefined> {
    await this.ensureState(invocationContext);
    this.addEntry(
      invocationContext.invocationId,
      DebugEntryType.USER_MESSAGE,
      undefined,
      {content: serializeContent(userMessage)},
    );
    return undefined;
  }

  override async beforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    await this.ensureState(invocationContext);
    this.addEntry(
      invocationContext.invocationId,
      DebugEntryType.INVOCATION_START,
      invocationContext.agent?.name,
      {branch: invocationContext.branch},
    );
    return undefined;
  }

  override async beforeAgentCallback({
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    this.addEntry(
      callbackContext.invocationId,
      DebugEntryType.AGENT_START,
      callbackContext.agentName,
      {branch: callbackContext.invocationContext.branch},
    );
    return undefined;
  }

  override async afterAgentCallback({
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    this.addEntry(
      callbackContext.invocationId,
      DebugEntryType.AGENT_END,
      callbackContext.agentName,
      {},
    );
    return undefined;
  }

  override async beforeModelCallback({
    callbackContext,
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const data: Record<string, unknown> = {
      model: llmRequest.model,
      content_count: llmRequest.contents.length,
      contents: llmRequest.contents.map(serializeContent),
    };
    const toolNames = Object.keys(llmRequest.toolsDict);
    if (toolNames.length > 0) {
      data['tools'] = toolNames;
    }
    const config = serializeRequestConfig(
      llmRequest,
      this.includeSystemInstruction,
    );
    if (config) {
      data['config'] = config;
    }
    this.addEntry(
      callbackContext.invocationId,
      DebugEntryType.LLM_REQUEST,
      callbackContext.agentName,
      data,
    );
    return undefined;
  }

  override async afterModelCallback({
    callbackContext,
    llmResponse,
  }: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    this.addEntry(
      callbackContext.invocationId,
      DebugEntryType.LLM_RESPONSE,
      callbackContext.agentName,
      serializeLlmResponse(llmResponse),
    );
    return undefined;
  }

  override async onModelErrorCallback({
    callbackContext,
    llmRequest,
    error,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<LlmResponse | undefined> {
    this.addEntry(
      callbackContext.invocationId,
      DebugEntryType.LLM_ERROR,
      callbackContext.agentName,
      {
        error_type: error.name,
        error_message: error.message,
        model: llmRequest.model,
      },
    );
    return undefined;
  }

  override async beforeToolCallback({
    tool,
    toolArgs,
    toolContext,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    this.addEntry(
      toolContext.invocationId,
      DebugEntryType.TOOL_CALL,
      toolContext.agentName,
      {
        tool_name: tool.name,
        function_call_id: toolContext.functionCallId,
        args: safeSerializeRecord(toolArgs),
      },
    );
    return undefined;
  }

  override async afterToolCallback({
    tool,
    toolContext,
    result,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    this.addEntry(
      toolContext.invocationId,
      DebugEntryType.TOOL_RESPONSE,
      toolContext.agentName,
      {
        tool_name: tool.name,
        function_call_id: toolContext.functionCallId,
        result: safeSerializeRecord(result),
      },
    );
    return undefined;
  }

  override async onToolErrorCallback({
    tool,
    toolArgs,
    toolContext,
    error,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    error: Error;
  }): Promise<Record<string, unknown> | undefined> {
    this.addEntry(
      toolContext.invocationId,
      DebugEntryType.TOOL_ERROR,
      toolContext.agentName,
      {
        tool_name: tool.name,
        function_call_id: toolContext.functionCallId,
        args: safeSerializeRecord(toolArgs),
        error_type: error.name,
        error_message: error.message,
      },
    );
    return undefined;
  }

  override async onEventCallback({
    invocationContext,
    event,
  }: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    this.addEntry(
      invocationContext.invocationId,
      DebugEntryType.EVENT,
      event.author,
      serializeEvent(event),
    );
    return undefined;
  }

  override async afterRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    const invocationId = invocationContext.invocationId;
    const state = this.invocationStates.get(invocationId);
    if (!state) {
      logger.warn(
        `No debug state for invocation ${invocationId}, skipping write`,
      );
      return;
    }

    if (this.includeSessionState) {
      const session = invocationContext.session;
      this.addEntry(
        invocationId,
        DebugEntryType.SESSION_STATE_SNAPSHOT,
        undefined,
        {
          state: safeSerializeRecord(session.state),
          event_count: session.events.length,
        },
      );
    }
    this.addEntry(invocationId, DebugEntryType.INVOCATION_END, undefined, {});

    this.invocationStates.delete(invocationId);
    await this.writeDocument(state);
  }

  /**
   * Returns the state for an invocation, creating it when the invocation has
   * not been seen yet.
   *
   * The runner calls `onUserMessageCallback` before `beforeRunCallback`, so
   * whichever arrives first opens the record.
   */
  private async ensureState(
    invocationContext: InvocationContext,
  ): Promise<void> {
    const invocationId = invocationContext.invocationId;
    if (this.invocationStates.has(invocationId)) {
      return;
    }
    await this.evictOldest();
    this.invocationStates.set(invocationId, {
      invocationId,
      sessionId: invocationContext.session.id,
      appName: invocationContext.session.appName,
      userId: invocationContext.userId,
      startTime: new Date().toISOString(),
      entries: [],
    });
  }

  /**
   * Flushes and drops the oldest buffered invocation when the buffer is full.
   *
   * An invocation that is abandoned or that crashes never reaches
   * `afterRunCallback`, so without this the buffer grows for the life of the
   * process.
   */
  private async evictOldest(): Promise<void> {
    if (this.invocationStates.size < this.maxBufferedInvocations) {
      return;
    }
    // A Map iterates in insertion order, so the first entry is the oldest.
    const [oldestId, oldest] = [...this.invocationStates][0];
    this.invocationStates.delete(oldestId);
    oldest.incomplete = true;
    await this.writeDocument(oldest);
  }

  private addEntry(
    invocationId: string,
    entryType: DebugEntryType,
    agentName: string | undefined,
    data: Record<string, unknown>,
  ): void {
    const state = this.invocationStates.get(invocationId);
    if (!state) {
      logger.warn(
        `No debug state for invocation ${invocationId}, skipping entry`,
      );
      return;
    }
    state.entries.push({
      timestamp: new Date().toISOString(),
      entryType,
      invocationId,
      agentName,
      data: safeSerializeRecord(data),
    });
  }

  /** Appends one invocation to the output file. Never throws. */
  private async writeDocument(state: InvocationDebugState): Promise<void> {
    try {
      const handle = await fs.open(this.outputPath, 'a', OUTPUT_FILE_MODE);
      try {
        await this.warnIfReadableBeyondOwner(handle);
        await handle.write(
          DOCUMENT_SEPARATOR +
            yaml.dump(toDocument(state), {
              sortKeys: false,
              lineWidth: YAML_LINE_WIDTH,
              noRefs: true,
            }),
        );
      } finally {
        await handle.close();
      }
      logger.debug(
        `Wrote debug data for invocation ${state.invocationId} to ${this.outputPath}`,
      );
    } catch (e: unknown) {
      logger.error(`Failed to write debug data: ${e}`);
    }
  }

  /**
   * Warns once when the output file is readable by anyone but its owner.
   *
   * {@link OUTPUT_FILE_MODE} only applies to a file this plugin creates. A
   * file left behind by an earlier run keeps whatever mode it had, and
   * silently changing a mode the user chose is worse than saying so.
   */
  private async warnIfReadableBeyondOwner(
    handle: fs.FileHandle,
  ): Promise<void> {
    if (this.warnedAboutOutputMode) {
      return;
    }
    const {mode} = await handle.stat();
    if ((mode & GROUP_AND_OTHER_MODE_BITS) === 0) {
      return;
    }
    this.warnedAboutOutputMode = true;
    logger.warn(
      `Debug output file ${this.outputPath} is readable beyond its owner and` +
        ' holds whole prompts and responses; restrict it to mode 600.',
    );
  }
}
