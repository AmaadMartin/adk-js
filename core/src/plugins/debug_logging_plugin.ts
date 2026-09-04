/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';

import {BaseAgent} from '../agents/base_agent.js';
import {Context} from '../agents/context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event, isFinalResponse} from '../events/event.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {BaseTool} from '../tools/base_tool.js';
import {logger} from '../utils/logger.js';
import {safeSerialize, safeSerializeRecord} from '../utils/redact_secrets.js';

import {BasePlugin} from './base_plugin.js';

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

/** The kind of a recorded debug entry. */
export enum DebugEntryType {
  INVOCATION_START = 'invocation_start',
  USER_MESSAGE = 'user_message',
  AGENT_START = 'agent_start',
  AGENT_END = 'agent_end',
  LLM_REQUEST = 'llm_request',
  LLM_RESPONSE = 'llm_response',
  LLM_ERROR = 'llm_error',
  TOOL_CALL = 'tool_call',
  TOOL_RESPONSE = 'tool_response',
  TOOL_ERROR = 'tool_error',
  EVENT = 'event',
  SESSION_STATE_SNAPSHOT = 'session_state_snapshot',
  INVOCATION_END = 'invocation_end',
}

/** A single debug entry recorded at a callback point. */
interface DebugEntry {
  /** ISO-8601 timestamp of when the entry was recorded. */
  timestamp: string;
  entryType: DebugEntryType;
  invocationId: string;
  agentName?: string;
  /** The captured, redacted payload for this entry. */
  data: Record<string, unknown>;
}

/** The debug state accumulated across the callbacks of one invocation. */
interface InvocationDebugState {
  invocationId: string;
  sessionId: string;
  appName: string;
  /** Always present: an adk-js `Session` always carries a user id. */
  userId: string;
  /** ISO-8601 timestamp of when the invocation started. */
  startTime: string;
  entries: DebugEntry[];
  /**
   * Set when the trace was flushed without its invocation ever reaching
   * `afterRunCallback`, so a reader can tell a truncated trace from a
   * finished one. See {@link DebugLoggingPluginOptions.maxBufferedInvocations}.
   */
  incomplete?: boolean;
}

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
   * invocation is flushed and dropped once this many are held. Pass a
   * non-positive number to hold every invocation. Defaults to 64.
   */
  maxBufferedInvocations?: number;
}

/** Serializes one part, dropping every field it does not carry. */
function serializePart(part: Part): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (part.text) {
    data['text'] = part.text;
  }
  if (part.functionCall) {
    data['functionCall'] = {
      id: part.functionCall.id,
      name: part.functionCall.name,
      args: safeSerialize(part.functionCall.args),
    };
  }
  if (part.functionResponse) {
    data['functionResponse'] = {
      id: part.functionResponse.id,
      name: part.functionResponse.name,
      response: safeSerialize(part.functionResponse.response),
    };
  }
  if (part.inlineData) {
    data['inlineData'] = {
      mimeType: part.inlineData.mimeType,
      displayName: part.inlineData.displayName,
      // The bytes are omitted to keep the file readable.
      dataOmitted: true,
    };
  }
  if (part.fileData) {
    data['fileData'] = {
      fileUri: part.fileData.fileUri,
      mimeType: part.fileData.mimeType,
    };
  }
  if (part.codeExecutionResult) {
    data['codeExecutionResult'] = {
      outcome: part.codeExecutionResult.outcome,
      output: part.codeExecutionResult.output,
    };
  }
  if (part.executableCode) {
    data['executableCode'] = {
      language: part.executableCode.language,
      code: part.executableCode.code,
    };
  }
  return data;
}

/**
 * Serializes content to a plain, redacted mapping.
 *
 * @param content The content to serialize.
 * @returns `undefined` when there is no content, otherwise its role and the
 *     parts that carry something.
 */
export function serializeContent(
  content: Content | undefined,
): Record<string, unknown> | undefined {
  if (!content) {
    return undefined;
  }
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content.parts ?? []) {
    const data = serializePart(part);
    if (Object.keys(data).length > 0) {
      parts.push(data);
    }
  }
  return {role: content.role, parts};
}

/** Builds the `config` block of an `llm_request` entry. */
function serializeRequestConfig(
  llmRequest: LlmRequest,
  includeSystemInstruction: boolean,
): Record<string, unknown> | undefined {
  const config = llmRequest.config;
  if (!config) {
    return undefined;
  }
  const data: Record<string, unknown> = {};
  const systemInstruction = config.systemInstruction;
  if (systemInstruction) {
    if (includeSystemInstruction) {
      data['systemInstruction'] = safeSerialize(systemInstruction);
    } else if (typeof systemInstruction === 'string') {
      data['systemInstructionLength'] = systemInstruction.length;
    } else {
      data['hasSystemInstruction'] = true;
    }
  }
  if (config.temperature !== undefined) {
    data['temperature'] = config.temperature;
  }
  if (config.topP !== undefined) {
    data['topP'] = config.topP;
  }
  if (config.topK !== undefined) {
    data['topK'] = config.topK;
  }
  if (config.maxOutputTokens !== undefined) {
    data['maxOutputTokens'] = config.maxOutputTokens;
  }
  if (config.responseMimeType) {
    data['responseMimeType'] = config.responseMimeType;
  }
  if (config.responseSchema) {
    data['hasResponseSchema'] = true;
  }
  return Object.keys(data).length > 0 ? data : undefined;
}

/** Builds the `actions` block of an `event` entry. */
function serializeEventActions(
  event: Event,
): Record<string, unknown> | undefined {
  const actions = event.actions;
  const data: Record<string, unknown> = {};
  if (Object.keys(actions.stateDelta).length > 0) {
    data['stateDelta'] = safeSerializeRecord(actions.stateDelta);
  }
  if (Object.keys(actions.artifactDelta).length > 0) {
    // The filename -> version mapping is what makes an artifact write
    // traceable.
    data['artifactDelta'] = {...actions.artifactDelta};
  }
  if (actions.transferToAgent) {
    data['transferToAgent'] = actions.transferToAgent;
  }
  if (actions.escalate) {
    data['escalate'] = actions.escalate;
  }
  const requestedAuthConfigs = Object.keys(actions.requestedAuthConfigs).length;
  if (requestedAuthConfigs > 0) {
    // The count only: an auth config holds a credential.
    data['requestedAuthConfigs'] = requestedAuthConfigs;
  }
  return Object.keys(data).length > 0 ? data : undefined;
}

/** Builds the payload of an `event` entry. */
function serializeEvent(event: Event): Record<string, unknown> {
  const data: Record<string, unknown> = {
    eventId: event.id,
    author: event.author,
    content: serializeContent(event.content),
    isFinalResponse: isFinalResponse(event),
    partial: event.partial,
    turnComplete: event.turnComplete,
    branch: event.branch,
  };
  const actions = serializeEventActions(event);
  if (actions) {
    data['actions'] = actions;
  }
  if (event.groundingMetadata) {
    data['hasGroundingMetadata'] = true;
  }
  if (event.usageMetadata) {
    data['usageMetadata'] = {
      promptTokenCount: event.usageMetadata.promptTokenCount,
      candidatesTokenCount: event.usageMetadata.candidatesTokenCount,
      totalTokenCount: event.usageMetadata.totalTokenCount,
    };
  }
  if (event.errorCode) {
    data['errorCode'] = event.errorCode;
    data['errorMessage'] = event.errorMessage;
  }
  if (event.longRunningToolIds && event.longRunningToolIds.length > 0) {
    data['longRunningToolIds'] = [...event.longRunningToolIds];
  }
  return data;
}

/** Builds the payload of an `llm_response` entry. */
function serializeLlmResponse(
  llmResponse: LlmResponse,
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    content: serializeContent(llmResponse.content),
    partial: llmResponse.partial,
    turnComplete: llmResponse.turnComplete,
  };
  if (llmResponse.errorCode) {
    data['errorCode'] = llmResponse.errorCode;
    data['errorMessage'] = llmResponse.errorMessage;
  }
  if (llmResponse.usageMetadata) {
    data['usageMetadata'] = {
      promptTokenCount: llmResponse.usageMetadata.promptTokenCount,
      candidatesTokenCount: llmResponse.usageMetadata.candidatesTokenCount,
      totalTokenCount: llmResponse.usageMetadata.totalTokenCount,
      cachedContentTokenCount:
        llmResponse.usageMetadata.cachedContentTokenCount,
    };
  }
  if (llmResponse.groundingMetadata) {
    data['hasGroundingMetadata'] = true;
  }
  if (llmResponse.finishReason) {
    data['finishReason'] = llmResponse.finishReason;
  }
  if (llmResponse.modelVersion) {
    data['modelVersion'] = llmResponse.modelVersion;
  }
  return data;
}

/** Renders one buffered invocation as the mapping written to the file. */
function toDocument(state: InvocationDebugState): Record<string, unknown> {
  return {
    invocationId: state.invocationId,
    sessionId: state.sessionId,
    appName: state.appName,
    userId: state.userId,
    startTime: state.startTime,
    ...(state.incomplete ? {incomplete: true} : {}),
    entries: state.entries.map((entry) => ({
      timestamp: entry.timestamp,
      entryType: entry.entryType,
      invocationId: entry.invocationId,
      ...(entry.agentName === undefined ? {} : {agentName: entry.agentName}),
      data: entry.data,
    })),
  };
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
  private readonly outputPath: string;
  private readonly includeSessionState: boolean;
  private readonly includeSystemInstruction: boolean;
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
      contentCount: llmRequest.contents.length,
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
        errorType: error.name,
        errorMessage: error.message,
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
        toolName: tool.name,
        functionCallId: toolContext.functionCallId,
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
        toolName: tool.name,
        functionCallId: toolContext.functionCallId,
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
        toolName: tool.name,
        functionCallId: toolContext.functionCallId,
        args: safeSerializeRecord(toolArgs),
        errorType: error.name,
        errorMessage: error.message,
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
          eventCount: session.events.length,
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
    if (
      this.maxBufferedInvocations <= 0 ||
      this.invocationStates.size < this.maxBufferedInvocations
    ) {
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
              noCompatMode: true,
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
