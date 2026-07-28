/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {Content} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {Context} from '../agents/context.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event, isFinalResponse} from '../events/event.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {BaseTool} from '../tools/base_tool.js';
import {logger} from '../utils/logger.js';

import {BasePlugin} from './base_plugin.js';

/**
 * A single debug log entry recorded at a callback point.
 */
interface DebugEntry {
  /** ISO-8601 timestamp of when the entry was recorded. */
  timestamp: string;
  /** The kind of entry, e.g. `'user_message'`, `'llm_request'`, `'event'`. */
  entryType: string;
  /** The invocation this entry belongs to. */
  invocationId?: string;
  /** The agent associated with the entry, when applicable. */
  agentName?: string;
  /** The captured, JSON-safe payload for this entry. */
  data: Record<string, unknown>;
}

/**
 * The buffered debug state accumulated across the callbacks of a single
 * invocation. One of these is serialized to a single NDJSON line when the
 * invocation completes.
 */
interface InvocationDebugState {
  invocationId: string;
  sessionId: string;
  appName: string;
  userId?: string;
  /** ISO-8601 timestamp of when the invocation started. */
  startTime: string;
  entries: DebugEntry[];
}

/**
 * Options for configuring a {@link DebugLoggingPlugin}.
 */
export interface DebugLoggingPluginOptions {
  /** The name of the plugin instance. Defaults to `'debug_logging_plugin'`. */
  name?: string;
  /** Path to the output file. Defaults to `'adk_debug.jsonl'`. */
  outputPath?: string;
  /** Whether to include a session-state snapshot. Defaults to `true`. */
  includeSessionState?: boolean;
  /** Whether to include full system instructions. Defaults to `true`. */
  includeSystemInstruction?: boolean;
}

/**
 * A plugin that captures the complete interaction trace to a file.
 *
 * Unlike {@link LoggingPlugin}, which writes human-readable lines to the
 * console, this plugin records a durable, machine-readable capture of an entire
 * invocation for offline / after-the-fact debugging, including:
 * - LLM requests (model, system instruction, contents, tools)
 * - LLM responses (content, usage metadata, errors)
 * - Tool calls with arguments and tool responses with results
 * - Events yielded from the runner
 * - Model and tool errors
 * - A session-state snapshot at the end of each invocation
 *
 * The output is written as **NDJSON** (newline-delimited JSON): each invocation
 * is buffered in memory and, on `afterRunCallback`, appended to the output file
 * as exactly one JSON object per line. One line == one complete invocation
 * trace, so the file is trivially parseable line-by-line with `JSON.parse`.
 *
 * This plugin observes only; every callback returns `undefined` and never
 * short-circuits the pipeline. Serialization and file-write failures are caught
 * internally so a debug logger can never break the run.
 *
 * Example:
 * ```typescript
 * const debugPlugin = new DebugLoggingPlugin({outputPath: '/tmp/adk_debug.jsonl'});
 * const runner = new InMemoryRunner({
 *   agent: myAgent,
 *   appName: 'my-app',
 *   plugins: [debugPlugin],
 * });
 * ```
 */
export class DebugLoggingPlugin extends BasePlugin {
  private readonly outputPath: string;
  private readonly includeSessionState: boolean;
  private readonly includeSystemInstruction: boolean;
  private readonly invocationStates = new Map<string, InvocationDebugState>();

  /**
   * Initialize the debug logging plugin.
   *
   * @param options Configuration for the plugin. See
   *     {@link DebugLoggingPluginOptions}.
   */
  constructor(options: DebugLoggingPluginOptions = {}) {
    super(options.name ?? 'debug_logging_plugin');
    this.outputPath = options.outputPath ?? 'adk_debug.jsonl';
    this.includeSessionState = options.includeSessionState ?? true;
    this.includeSystemInstruction = options.includeSystemInstruction ?? true;
  }

  override async onUserMessageCallback({
    invocationContext,
    userMessage,
  }: {
    invocationContext: InvocationContext;
    userMessage: Content;
  }): Promise<Content | undefined> {
    this.addEntry(invocationContext.invocationId, 'user_message', {
      content: this.serializeContent(userMessage),
    });
    return undefined;
  }

  override async beforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    const invocationId = invocationContext.invocationId;
    const session = invocationContext.session;

    this.invocationStates.set(invocationId, {
      invocationId,
      sessionId: session.id,
      appName: session.appName,
      userId: invocationContext.userId,
      startTime: this.getTimestamp(),
      entries: [],
    });

    this.addEntry(invocationId, 'invocation_start', {
      agentName: invocationContext.agent?.name,
      branch: invocationContext.branch,
    });
    return undefined;
  }

  override async onEventCallback({
    invocationContext,
    event,
  }: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    const eventData: Record<string, unknown> = {
      eventId: event.id,
      author: event.author,
      content: this.serializeContent(event.content),
      isFinalResponse: isFinalResponse(event),
      partial: event.partial,
      turnComplete: event.turnComplete,
      branch: event.branch,
    };

    const actions = event.actions;
    const actionsData: Record<string, unknown> = {};
    if (Object.keys(actions.stateDelta).length > 0) {
      actionsData['stateDelta'] = this.safeSerialize(actions.stateDelta);
    }
    if (Object.keys(actions.artifactDelta).length > 0) {
      actionsData['artifactDelta'] = {...actions.artifactDelta};
    }
    if (actions.transferToAgent) {
      actionsData['transferToAgent'] = actions.transferToAgent;
    }
    if (actions.escalate) {
      actionsData['escalate'] = actions.escalate;
    }
    if (Object.keys(actions.requestedAuthConfigs).length > 0) {
      actionsData['requestedAuthConfigs'] = Object.keys(
        actions.requestedAuthConfigs,
      ).length;
    }
    if (Object.keys(actionsData).length > 0) {
      eventData['actions'] = actionsData;
    }

    if (event.groundingMetadata) {
      eventData['hasGroundingMetadata'] = true;
    }

    if (event.usageMetadata) {
      eventData['usageMetadata'] = {
        promptTokenCount: event.usageMetadata.promptTokenCount,
        candidatesTokenCount: event.usageMetadata.candidatesTokenCount,
        totalTokenCount: event.usageMetadata.totalTokenCount,
      };
    }

    if (event.errorCode) {
      eventData['errorCode'] = event.errorCode;
      eventData['errorMessage'] = event.errorMessage;
    }

    if (event.longRunningToolIds && event.longRunningToolIds.length > 0) {
      eventData['longRunningToolIds'] = [...event.longRunningToolIds];
    }

    this.addEntry(invocationContext.invocationId, 'event', {
      agentName: event.author,
      ...eventData,
    });
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
      this.addEntry(invocationId, 'session_state_snapshot', {
        state: this.safeSerialize(session.state),
        eventCount: session.events.length,
      });
    }

    this.addEntry(invocationId, 'invocation_end', {});

    try {
      const line = JSON.stringify(state) + '\n';
      await fs.mkdir(path.dirname(this.outputPath), {recursive: true});
      await fs.appendFile(this.outputPath, line, 'utf-8');
      logger.debug(
        `Wrote debug data for invocation ${invocationId} to ${this.outputPath}`,
      );
    } catch (e) {
      logger.error(`Failed to write debug data: ${e}`);
    } finally {
      this.invocationStates.delete(invocationId);
    }
  }

  override async beforeAgentCallback({
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    this.addEntry(callbackContext.invocationId, 'agent_start', {
      agentName: callbackContext.agentName,
      branch: callbackContext.invocationContext.branch,
    });
    return undefined;
  }

  override async afterAgentCallback({
    callbackContext,
  }: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<Content | undefined> {
    this.addEntry(callbackContext.invocationId, 'agent_end', {
      agentName: callbackContext.agentName,
    });
    return undefined;
  }

  override async beforeModelCallback({
    callbackContext,
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const requestData: Record<string, unknown> = {
      model: llmRequest.model,
      contentCount: llmRequest.contents.length,
      contents: llmRequest.contents.map((c) => this.serializeContent(c)),
    };

    if (llmRequest.toolsDict && Object.keys(llmRequest.toolsDict).length > 0) {
      requestData['tools'] = Object.keys(llmRequest.toolsDict);
    }

    if (llmRequest.config) {
      const config = llmRequest.config;
      const configData: Record<string, unknown> = {};

      if (this.includeSystemInstruction && config.systemInstruction) {
        configData['systemInstruction'] = config.systemInstruction;
      } else if (config.systemInstruction) {
        const si = config.systemInstruction;
        if (typeof si === 'string') {
          configData['systemInstructionLength'] = si.length;
        } else {
          configData['hasSystemInstruction'] = true;
        }
      }

      if (config.temperature !== undefined) {
        configData['temperature'] = config.temperature;
      }
      if (config.topP !== undefined) {
        configData['topP'] = config.topP;
      }
      if (config.topK !== undefined) {
        configData['topK'] = config.topK;
      }
      if (config.maxOutputTokens !== undefined) {
        configData['maxOutputTokens'] = config.maxOutputTokens;
      }
      if (config.responseMimeType) {
        configData['responseMimeType'] = config.responseMimeType;
      }
      if (config.responseSchema) {
        configData['hasResponseSchema'] = true;
      }

      if (Object.keys(configData).length > 0) {
        requestData['config'] = configData;
      }
    }

    this.addEntry(callbackContext.invocationId, 'llm_request', {
      agentName: callbackContext.agentName,
      ...requestData,
    });
    return undefined;
  }

  override async afterModelCallback({
    callbackContext,
    llmResponse,
  }: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    const responseData: Record<string, unknown> = {
      content: this.serializeContent(llmResponse.content),
      partial: llmResponse.partial,
      turnComplete: llmResponse.turnComplete,
    };

    if (llmResponse.errorCode) {
      responseData['errorCode'] = llmResponse.errorCode;
      responseData['errorMessage'] = llmResponse.errorMessage;
    }

    if (llmResponse.usageMetadata) {
      responseData['usageMetadata'] = {
        promptTokenCount: llmResponse.usageMetadata.promptTokenCount,
        candidatesTokenCount: llmResponse.usageMetadata.candidatesTokenCount,
        totalTokenCount: llmResponse.usageMetadata.totalTokenCount,
        cachedContentTokenCount:
          llmResponse.usageMetadata.cachedContentTokenCount,
      };
    }

    if (llmResponse.groundingMetadata) {
      responseData['hasGroundingMetadata'] = true;
    }

    if (llmResponse.finishReason) {
      responseData['finishReason'] = String(llmResponse.finishReason);
    }

    if (llmResponse.modelVersion) {
      responseData['modelVersion'] = llmResponse.modelVersion;
    }

    this.addEntry(callbackContext.invocationId, 'llm_response', {
      agentName: callbackContext.agentName,
      ...responseData,
    });
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
    this.addEntry(callbackContext.invocationId, 'llm_error', {
      agentName: callbackContext.agentName,
      errorType: error.name,
      errorMessage: error.message,
      model: llmRequest.model,
    });
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
    this.addEntry(toolContext.invocationId, 'tool_call', {
      agentName: toolContext.agentName,
      toolName: tool.name,
      functionCallId: toolContext.functionCallId,
      args: this.safeSerialize(toolArgs),
    });
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
    this.addEntry(toolContext.invocationId, 'tool_response', {
      agentName: toolContext.agentName,
      toolName: tool.name,
      functionCallId: toolContext.functionCallId,
      result: this.safeSerialize(result),
    });
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
    this.addEntry(toolContext.invocationId, 'tool_error', {
      agentName: toolContext.agentName,
      toolName: tool.name,
      functionCallId: toolContext.functionCallId,
      args: this.safeSerialize(toolArgs),
      errorType: error.name,
      errorMessage: error.message,
    });
    return undefined;
  }

  /** Returns the current time as an ISO-8601 string. */
  private getTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Serializes a {@link Content} into a plain, JSON-safe object, capturing only
   * the sub-fields that are present on each part and omitting raw binary
   * payloads.
   */
  private serializeContent(
    content?: Content,
  ): Record<string, unknown> | undefined {
    if (!content) {
      return undefined;
    }

    const parts: Array<Record<string, unknown>> = [];
    for (const part of content.parts ?? []) {
      const partData: Record<string, unknown> = {};
      if (part.text) {
        partData['text'] = part.text;
      }
      if (part.functionCall) {
        partData['functionCall'] = {
          id: part.functionCall.id,
          name: part.functionCall.name,
          args: part.functionCall.args,
        };
      }
      if (part.functionResponse) {
        partData['functionResponse'] = {
          id: part.functionResponse.id,
          name: part.functionResponse.name,
          response: this.safeSerialize(part.functionResponse.response),
        };
      }
      if (part.inlineData) {
        partData['inlineData'] = {
          mimeType: part.inlineData.mimeType,
          displayName: part.inlineData.displayName,
          // Omit actual data to keep file size manageable.
          _dataOmitted: true,
        };
      }
      if (part.fileData) {
        partData['fileData'] = {
          fileUri: part.fileData.fileUri,
          mimeType: part.fileData.mimeType,
        };
      }
      if (part.codeExecutionResult) {
        partData['codeExecutionResult'] = {
          outcome: String(part.codeExecutionResult.outcome),
          output: part.codeExecutionResult.output,
        };
      }
      if (part.executableCode) {
        partData['executableCode'] = {
          language: String(part.executableCode.language),
          code: part.executableCode.code,
        };
      }
      if (Object.keys(partData).length > 0) {
        parts.push(partData);
      }
    }

    return {role: content.role, parts};
  }

  /**
   * Defensively converts an arbitrary value into a JSON-safe form. Primitives
   * pass through, arrays and plain objects are mapped recursively, byte buffers
   * are replaced with a size marker, and anything that cannot be walked or
   * stringified degrades to a placeholder instead of throwing.
   */
  private safeSerialize(obj: unknown): unknown {
    if (obj === null || obj === undefined) {
      return obj;
    }
    const type = typeof obj;
    if (type === 'string' || type === 'number' || type === 'boolean') {
      return obj;
    }
    if (obj instanceof Uint8Array) {
      return `<bytes: ${obj.length} bytes>`;
    }
    try {
      if (Array.isArray(obj)) {
        return obj.map((item) => this.safeSerialize(item));
      }
      if (type === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(
          obj as Record<string, unknown>,
        )) {
          result[key] = this.safeSerialize(value);
        }
        return result;
      }
      return String(obj);
    } catch {
      return '<unserializable>';
    }
  }

  /**
   * Appends a debug entry to the buffered state for the given invocation. If no
   * state exists (e.g. an entry-adding callback fires without a preceding
   * `beforeRunCallback`), the entry is skipped with a warning rather than
   * throwing.
   */
  private addEntry(
    invocationId: string,
    entryType: string,
    {agentName, ...data}: {agentName?: string} & Record<string, unknown>,
  ): void {
    const state = this.invocationStates.get(invocationId);
    if (!state) {
      logger.warn(
        `No debug state for invocation ${invocationId}, skipping entry`,
      );
      return;
    }

    state.entries.push({
      timestamp: this.getTimestamp(),
      entryType,
      invocationId,
      agentName,
      data: this.safeSerialize(data) as Record<string, unknown>,
    });
  }
}
