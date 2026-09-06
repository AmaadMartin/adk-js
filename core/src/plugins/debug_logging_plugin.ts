/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
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

/** Default name of a {@link DebugLoggingPlugin} instance. */
const DEFAULT_PLUGIN_NAME = 'debug_logging_plugin';

/** Default basename of the trace file, created under `os.tmpdir()`. */
const DEFAULT_OUTPUT_FILENAME = 'adk_debug.jsonl';

/** Default size at which the trace file is rotated, in bytes. */
const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

/** Default number of in-flight invocations buffered before the oldest is evicted. */
const DEFAULT_MAX_BUFFERED_INVOCATIONS = 64;

/** Maximum object depth walked by {@link safeSerialize}. */
const MAX_SERIALIZE_DEPTH = 20;

/** Maximum number of characters retained for any single captured string. */
const MAX_STRING_LENGTH = 100_000;

/** Mode for the trace file: readable and writable by its owner only. */
const OUTPUT_FILE_MODE = 0o600;

/** Mode for auto-created parent directories: accessible by its owner only. */
const OUTPUT_DIR_MODE = 0o700;

/** Suffix of the single rotated-away trace file. */
const ROTATED_SUFFIX = '.1';

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
  /**
   * Set when the trace was flushed without its invocation ever reaching
   * `afterRunCallback` (see {@link DebugLoggingPluginOptions.maxBufferedInvocations}),
   * so a consumer can tell a truncated trace from a complete one.
   */
  incomplete?: boolean;
}

/**
 * Hook invoked on every captured payload immediately before it is recorded.
 *
 * Receives the raw payload for an entry and returns the payload to record in
 * its place, letting an application strip credentials, PII or oversized fields
 * that would otherwise be written verbatim to disk. The returned value is
 * serialized defensively afterwards, so it may contain arbitrary values.
 *
 * If the hook throws, the payload is dropped entirely (replaced with
 * `{_redactionFailed: true}`) rather than written unredacted.
 *
 * @param entryType The kind of entry being recorded, e.g. `'llm_request'`,
 *     `'tool_call'`, `'session_state_snapshot'`.
 * @param data The raw payload for that entry.
 */
export type DebugRedactor = (
  entryType: string,
  data: Record<string, unknown>,
) => Record<string, unknown>;

/**
 * Options for configuring a {@link DebugLoggingPlugin}.
 */
export interface DebugLoggingPluginOptions {
  /** The name of the plugin instance. Defaults to `'debug_logging_plugin'`. */
  name?: string;
  /**
   * Path to the output file. Defaults to `'adk_debug.jsonl'` under
   * `os.tmpdir()`. A relative path resolves against `process.cwd()`.
   */
  outputPath?: string;
  /**
   * Whether to include a session-state snapshot. Defaults to `true`. Session
   * state is a common place for applications to stash credentials; see the
   * security note on {@link DebugLoggingPlugin}.
   */
  includeSessionState?: boolean;
  /** Whether to include full system instructions. Defaults to `true`. */
  includeSystemInstruction?: boolean;
  /**
   * Called on every captured payload before it is recorded, to strip secrets.
   * Defaults to no redaction. See {@link DebugRedactor}.
   */
  redact?: DebugRedactor;
  /**
   * Size at which the trace file is rotated to `<outputPath>.1`, in bytes.
   * Defaults to 100 MiB; a non-positive value disables rotation and lets the
   * file grow without bound. At most one rotated file is kept, so total disk
   * usage is bounded by roughly twice this value.
   */
  maxOutputBytes?: number;
  /**
   * Number of in-flight invocations buffered in memory before the oldest is
   * flushed as `incomplete` and evicted. Defaults to 64. This bounds the
   * plugin's memory when a run never reaches `afterRunCallback` — an aborted,
   * early-exited or failed run currently skips it.
   */
  maxBufferedInvocations?: number;
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
 * ## Security: the output file is sensitive
 *
 * **This file contains full prompts, complete LLM responses, tool arguments,
 * tool results and a session-state snapshot, verbatim.** For an authenticated
 * tool those routinely carry bearer tokens, API keys and customer records, and
 * `session.state` is where applications commonly stash exactly that. Treat the
 * output as credential material:
 *
 * - Do not enable it in production without a retention and deletion policy.
 * - Use {@link DebugLoggingPluginOptions.redact} to strip your own secrets, and
 *   `includeSessionState: false` / `includeSystemInstruction: false` to drop
 *   whole categories of payload.
 * - The file is created `0600` and any directory created for it `0700`, so
 *   neither is world-readable regardless of the process umask. Permissions on a
 *   file that already exists are left alone.
 * - The default path is under `os.tmpdir()`, deliberately not the working
 *   directory, so a trace is never one `git add .` away from being committed.
 *
 * ## Output format and size
 *
 * The output is written as **NDJSON** (newline-delimited JSON): each invocation
 * is buffered in memory and, on `afterRunCallback`, appended to the output file
 * as exactly one JSON object per line. One line == one complete invocation
 * trace, so the file is trivially parseable line-by-line with `JSON.parse`.
 *
 * Growth is bounded rather than unbounded: individual captured strings are
 * truncated past 100,000 characters, and the file is rotated to
 * `<outputPath>.1` once it would exceed
 * {@link DebugLoggingPluginOptions.maxOutputBytes} (100 MiB by default), so
 * total disk usage stays around twice that. Rotation is not coordinated across
 * processes; point separate processes at separate files.
 *
 * ## Lifetime
 *
 * This plugin observes only; every callback returns `undefined` and never
 * short-circuits the pipeline. Serialization and file-write failures are caught
 * internally so a debug logger can never break the run.
 *
 * Note that `Runner` calls `afterRunCallback` on the happy path only, so an
 * aborted or failed run does not flush its own trace. Such a trace is retained
 * in memory and flushed with `incomplete: true` once
 * {@link DebugLoggingPluginOptions.maxBufferedInvocations} newer invocations
 * have started, which bounds the memory a long-lived process can accumulate.
 *
 * Example:
 * ```typescript
 * const debugPlugin = new DebugLoggingPlugin({
 *   outputPath: '/tmp/adk_debug.jsonl',
 *   redact: (entryType, data) =>
 *     entryType === 'tool_call' ? {...data, args: '<redacted>'} : data,
 * });
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
  private readonly redact?: DebugRedactor;
  private readonly maxOutputBytes: number;
  private readonly maxBufferedInvocations: number;
  private readonly invocationStates = new Map<string, InvocationDebugState>();

  /**
   * Initialize the debug logging plugin.
   *
   * @param options Configuration for the plugin. See
   *     {@link DebugLoggingPluginOptions}.
   */
  constructor(options: DebugLoggingPluginOptions = {}) {
    super(options.name ?? DEFAULT_PLUGIN_NAME);
    this.outputPath =
      options.outputPath ?? path.join(os.tmpdir(), DEFAULT_OUTPUT_FILENAME);
    this.includeSessionState = options.includeSessionState ?? true;
    this.includeSystemInstruction = options.includeSystemInstruction ?? true;
    this.redact = options.redact;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
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
    // `Runner` fires this before `beforeRunCallback`, so the state has to be
    // created here rather than assumed.
    await this.ensureState(invocationContext);
    this.addEntry(invocationContext.invocationId, 'user_message', {
      content: serializeContent(userMessage),
    });
    return undefined;
  }

  override async beforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    const invocationId = invocationContext.invocationId;
    // Reuses the state `onUserMessageCallback` may already have created, so the
    // user message is not clobbered.
    await this.ensureState(invocationContext);

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
      content: serializeContent(event.content),
      isFinalResponse: isFinalResponse(event),
      partial: event.partial,
      turnComplete: event.turnComplete,
      branch: event.branch,
    };

    const actions = event.actions;
    const actionsData: Record<string, unknown> = {};
    if (Object.keys(actions.stateDelta).length > 0) {
      actionsData['stateDelta'] = actions.stateDelta;
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
        state: session.state,
        eventCount: session.events.length,
      });
    }

    this.addEntry(invocationId, 'invocation_end', {});

    try {
      await this.writeState(state);
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
      contents: llmRequest.contents.map((c) => serializeContent(c)),
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
      content: serializeContent(llmResponse.content),
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
      args: toolArgs,
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
      result,
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
      args: toolArgs,
      errorType: error.name,
      errorMessage: error.message,
    });
    return undefined;
  }

  /**
   * Returns the buffered state for an invocation, creating it if this is the
   * first callback to fire for that invocation. Creating lazily keeps the
   * plugin correct whichever of `onUserMessageCallback` / `beforeRunCallback`
   * the runner happens to call first, and never discards entries already
   * recorded for the invocation.
   */
  private async ensureState(
    invocationContext: InvocationContext,
  ): Promise<InvocationDebugState> {
    const invocationId = invocationContext.invocationId;
    const existing = this.invocationStates.get(invocationId);
    if (existing) {
      return existing;
    }

    await this.evictOldest();

    const session = invocationContext.session;
    const state: InvocationDebugState = {
      invocationId,
      sessionId: session.id,
      appName: session.appName,
      userId: invocationContext.userId,
      startTime: getTimestamp(),
      entries: [],
    };
    this.invocationStates.set(invocationId, state);
    return state;
  }

  /**
   * Flushes and drops the oldest buffered invocations until there is room for
   * one more. Only invocations that never reached `afterRunCallback` can
   * accumulate here; writing them out as `incomplete` means an aborted or
   * failed run still lands on disk instead of being silently dropped.
   */
  private async evictOldest(): Promise<void> {
    while (this.invocationStates.size >= this.maxBufferedInvocations) {
      const oldest = this.invocationStates.entries().next();
      if (oldest.done) {
        // Only reachable for a non-positive cap, where the loop condition holds
        // even though there is nothing buffered to evict.
        return;
      }
      const [oldestId, stale] = oldest.value;
      this.invocationStates.delete(oldestId);
      logger.warn(
        `Debug buffer holds ${this.maxBufferedInvocations} invocations; ` +
          `invocation ${oldestId} never reached afterRunCallback. Flushing ` +
          `it as incomplete.`,
      );
      try {
        await this.writeState({...stale, incomplete: true});
      } catch (e) {
        logger.error(`Failed to write incomplete debug data: ${e}`);
      }
    }
  }

  /**
   * Appends one invocation trace to the output file as a single NDJSON line,
   * rotating the file first if the append would take it past its size cap.
   */
  private async writeState(state: InvocationDebugState): Promise<void> {
    const line = JSON.stringify(state) + '\n';
    await fs.mkdir(path.dirname(this.outputPath), {
      recursive: true,
      mode: OUTPUT_DIR_MODE,
    });
    await this.rotateIfFull(Buffer.byteLength(line, 'utf-8'));
    // `mode` applies only when this call creates the file; an operator who has
    // deliberately relaxed the permissions on an existing file keeps them.
    await fs.appendFile(this.outputPath, line, {
      encoding: 'utf-8',
      mode: OUTPUT_FILE_MODE,
    });
  }

  /**
   * Renames the output file to `<outputPath>.1` when appending `incomingBytes`
   * would push it past {@link DebugLoggingPluginOptions.maxOutputBytes},
   * replacing any previous rotated file.
   */
  private async rotateIfFull(incomingBytes: number): Promise<void> {
    if (this.maxOutputBytes <= 0) {
      return;
    }
    let currentBytes: number;
    try {
      currentBytes = (await fs.stat(this.outputPath)).size;
    } catch {
      // No output file yet, so there is nothing to rotate.
      return;
    }
    if (currentBytes + incomingBytes <= this.maxOutputBytes) {
      return;
    }
    const rotatedPath = this.outputPath + ROTATED_SUFFIX;
    await fs.rename(this.outputPath, rotatedPath);
    logger.debug(`Rotated debug trace file to ${rotatedPath}`);
  }

  /**
   * Appends a debug entry to the buffered state for the given invocation. If no
   * state exists (e.g. an entry-adding callback fires outside of any run), the
   * entry is skipped rather than throwing.
   */
  private addEntry(
    invocationId: string,
    entryType: string,
    {agentName, ...data}: {agentName?: string} & Record<string, unknown>,
  ): void {
    const state = this.invocationStates.get(invocationId);
    if (!state) {
      logger.debug(
        `No debug state for invocation ${invocationId}, skipping entry`,
      );
      return;
    }

    state.entries.push({
      timestamp: getTimestamp(),
      entryType,
      invocationId,
      agentName,
      data: this.capture(entryType, data),
    });
  }

  /**
   * Runs the caller's redaction hook over a raw payload and converts the result
   * into a JSON-safe form. A hook that throws fails closed: the payload is
   * dropped rather than recorded unredacted.
   */
  private capture(
    entryType: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    let payload: unknown = data;
    if (this.redact) {
      try {
        payload = this.redact(entryType, data);
      } catch (e) {
        logger.error(
          `redact() threw for a ${entryType} entry; dropping the payload ` +
            `rather than recording it unredacted: ${e}`,
        );
        return {_redactionFailed: true};
      }
    }
    const serialized = safeSerialize(payload);
    return isRecord(serialized) ? serialized : {_unserializable: serialized};
  }
}

/** Returns the current time as an ISO-8601 string. */
function getTimestamp(): string {
  return new Date().toISOString();
}

/** Narrows an arbitrary value to a plain, non-array JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Caps a single captured string, noting how much was dropped. */
function truncate(text: string): string {
  if (text.length <= MAX_STRING_LENGTH) {
    return text;
  }
  const dropped = text.length - MAX_STRING_LENGTH;
  return `${text.slice(0, MAX_STRING_LENGTH)}...<truncated ${dropped} chars>`;
}

/**
 * Serializes a {@link Content} into a plain object, capturing only the
 * sub-fields that are present on each part and omitting raw binary payloads.
 * Values are left as-is; {@link safeSerialize} runs over the surrounding entry.
 */
function serializeContent(
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
        response: part.functionResponse.response,
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
 * pass through (strings capped at {@link MAX_STRING_LENGTH}), byte buffers are
 * replaced with a size marker, and arrays and plain objects are mapped
 * recursively. Anything that cannot be walked or stringified degrades to a
 * placeholder instead of throwing.
 *
 * The walk is bounded in both directions: a value already on the current path
 * becomes `'<circular>'` and anything deeper than {@link MAX_SERIALIZE_DEPTH}
 * becomes `'<max depth>'`, so self-referential and pathologically nested
 * payloads terminate instead of exhausting the stack. `seen` tracks the current
 * path rather than every value visited, so a value referenced twice as a
 * sibling still serializes both times.
 *
 * @param value The value to convert.
 * @param seen Objects on the path from the root to `value`, for cycle
 *     detection. Callers pass nothing.
 * @param depth Current recursion depth. Callers pass nothing.
 */
function safeSerialize(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return truncate(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Uint8Array) {
    return `<bytes: ${value.length} bytes>`;
  }
  if (typeof value !== 'object') {
    // Functions, symbols and bigints have no JSON form; keep a readable label.
    try {
      return truncate(String(value));
    } catch {
      return '<unserializable>';
    }
  }
  if (depth >= MAX_SERIALIZE_DEPTH) {
    return '<max depth>';
  }
  if (seen.has(value)) {
    return '<circular>';
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => safeSerialize(item, seen, depth + 1));
    }
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      result[key] = safeSerialize(inner, seen, depth + 1);
    }
    return result;
  } catch {
    return '<unserializable>';
  } finally {
    seen.delete(value);
  }
}
