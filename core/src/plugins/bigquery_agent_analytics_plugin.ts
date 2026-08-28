/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content, GenerateContentConfig} from '@google/genai';
import {isSpanContextValid, trace} from '@opentelemetry/api';
import type {BaseAgent} from '../agents/base_agent.js';
import type {Context} from '../agents/context.js';
import type {InvocationContext} from '../agents/invocation_context.js';
import {
  Event,
  getFunctionCalls,
  getFunctionResponses,
  isFinalResponse,
} from '../events/event.js';
import type {LlmRequest} from '../models/llm_request.js';
import type {LlmResponse} from '../models/llm_response.js';
import type {BaseTool} from '../tools/base_tool.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {recursiveSmartTruncate} from '../utils/sanitize_utils.js';
import {BasePlugin} from './base_plugin.js';
import {
  formatContentSummary,
  parseAnalyticsContent,
  ParsedAnalyticsContent,
} from './bigquery_analytics_content.js';
import {
  AnalyticsEventType,
  AnalyticsRow,
  AnalyticsStatus,
  hitlMappingFor,
  TOOL_PAUSE_KIND,
} from './bigquery_analytics_schema.js';
import {
  AnalyticsDropReason,
  BigQueryRowWriter,
} from './bigquery_analytics_writer.js';

/** Plugin name registered with the runner's plugin manager. */
const PLUGIN_NAME = 'bigquery_agent_analytics';

/** Content written when the configured formatter throws. */
const FORMATTER_FAILED = '[FORMATTER_FAILED]';

/** Content written when the payload cannot be sanitized. */
const CONTENT_PARSE_FAILED = '[CONTENT_PARSE_FAILED]';

/**
 * Log lines for the two content failures. Both are constant: the payload, the
 * exception message and even a class name can be attacker-supplied, and this
 * plugin's whole purpose is to keep such values out of durable output.
 */
const FORMATTER_FAILED_LOG =
  'BigQuery analytics content formatter failed; writing a sentinel instead of the content.';
const CONTENT_PARSE_FAILED_LOG =
  'BigQuery analytics could not sanitize the content; writing a sentinel instead of it.';

/**
 * Logged when an event names a long-running call id that no function call in
 * that event carries. The id is left out: a model supplies it, so it is
 * untrusted like any other model output.
 */
const UNMATCHED_LONG_RUNNING_ID_LOG =
  'BigQuery analytics found a long-running tool id with no matching function call; writing the pause row without the call.';

/**
 * Invocations whose span stacks are kept at once. An invocation whose
 * `afterRunCallback` never fires would otherwise leak a stack forever, so the
 * oldest entries are evicted past this cap.
 */
const MAX_TRACKED_INVOCATIONS = 1024;

/** Default configuration values, matching adk-python's `BigQueryLoggerConfig`. */
const DEFAULT_TABLE_ID = 'agent_events';
const DEFAULT_LOCATION = 'US';
const DEFAULT_MAX_CONTENT_LENGTH = 500 * 1024;
const DEFAULT_CLUSTERING_FIELDS = ['event_type', 'agent', 'user_id'];
const DEFAULT_BATCH_SIZE = 1;
const DEFAULT_BATCH_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_QUEUE_MAX_SIZE = 10000;

/**
 * Generation-config fields captured into `attributes.llm_config`, paired with
 * the column name adk-python writes. The names are snake_case on the wire in
 * both SDKs even though the TypeScript field is camelCase.
 */
const LOGGED_GENERATION_CONFIG_KEYS: ReadonlyArray<
  readonly [keyof GenerateContentConfig, string]
> = [
  ['temperature', 'temperature'],
  ['topP', 'top_p'],
  ['topK', 'top_k'],
  ['candidateCount', 'candidate_count'],
  ['maxOutputTokens', 'max_output_tokens'],
  ['stopSequences', 'stop_sequences'],
  ['presencePenalty', 'presence_penalty'],
  ['frequencyPenalty', 'frequency_penalty'],
  ['responseMimeType', 'response_mime_type'],
  ['responseSchema', 'response_schema'],
  ['seed', 'seed'],
  ['responseLogprobs', 'response_logprobs'],
  ['logprobs', 'logprobs'],
];

/** What pushed a span, so an error callback only pops a span it owns. */
enum SpanKind {
  INVOCATION = 'invocation',
  AGENT = 'agent',
  LLM_REQUEST = 'llm_request',
  TOOL = 'tool',
}

/** One entry of an invocation's span stack. */
interface SpanRecord {
  spanId: string;
  traceId: string;
  startTimeMs: number;
  kind: SpanKind;
  firstTokenTimeMs?: number;
}

/** Turns a payload into the value written to the `content` column. */
export type AnalyticsContentFormatter = (
  content: unknown,
  eventType: string,
) => unknown;

/**
 * Tuning for {@link BigQueryAgentAnalyticsPlugin}.
 *
 * Every field is optional and falls back to the same default adk-python uses.
 * The two duration fields carry an `Ms` suffix and take milliseconds, where
 * Python takes float seconds.
 */
export interface BigQueryLoggerConfig {
  /** Whether the plugin writes anything at all. Defaults to true. */
  enabled?: boolean;
  /** When set, only these event types are written. */
  eventAllowlist?: AnalyticsEventType[];
  /** Event types that are never written. Applied before the allowlist. */
  eventDenylist?: AnalyticsEventType[];
  /** Maximum length of a captured string, or -1 for no limit. */
  maxContentLength?: number;
  /** Columns the events table is clustered by. */
  clusteringFields?: string[];
  /** Whether the `content_parts` column is populated. Defaults to true. */
  logMultiModalContent?: boolean;
  /** Rows per insert. Defaults to 1, which writes each row as it is produced. */
  batchSize?: number;
  /** How long a partial batch waits before it is written. */
  batchFlushIntervalMs?: number;
  /** How long `shutdown()` waits for the queue to drain. */
  shutdownTimeoutMs?: number;
  /** Rows held in memory before new ones are dropped. */
  queueMaxSize?: number;
  /** Replaces the captured payload before it is written. */
  contentFormatter?: AnalyticsContentFormatter;
  /** Whether `attributes.session_metadata` is written. Defaults to true. */
  logSessionMetadata?: boolean;
  /** Static tags copied into `attributes.custom_tags` on every row. */
  customTags?: Record<string, unknown>;
  /** Whether each run ends with a flush. Defaults to true. */
  flushOnRunEnd?: boolean;
}

/** Constructor parameters for {@link BigQueryAgentAnalyticsPlugin}. */
export interface BigQueryAgentAnalyticsPluginOptions {
  /** The Google Cloud project holding the dataset. */
  projectId: string;
  /** The dataset holding the events table. It must already exist. */
  datasetId: string;
  /** The events table. Created on first use. Defaults to `agent_events`. */
  tableId?: string;
  /** BigQuery location for the client and the created table. Defaults to `US`. */
  location?: string;
  /** Tuning, all of it optional. */
  config?: BigQueryLoggerConfig;
}

/** {@link BigQueryLoggerConfig} with every default filled in. */
interface ResolvedConfig {
  enabled: boolean;
  eventAllowlist?: AnalyticsEventType[];
  eventDenylist?: AnalyticsEventType[];
  maxContentLength: number;
  logMultiModalContent: boolean;
  contentFormatter?: AnalyticsContentFormatter;
  logSessionMetadata: boolean;
  customTags: Record<string, unknown>;
  flushOnRunEnd: boolean;
}

/** Structured fields one row carries beyond its content. */
interface AnalyticsEventData {
  status?: AnalyticsStatus;
  errorMessage?: string;
  latencyMs?: number;
  timeToFirstTokenMs?: number;
  model?: string;
  modelVersion?: string;
  usageMetadata?: unknown;
  finishReason?: string;
  extraAttributes?: Record<string, unknown>;
  traceIdOverride?: string;
  spanIdOverride?: string;
  parentSpanIdOverride?: string;
  sourceEvent?: Event;
}

/** Everything {@link BigQueryAgentAnalyticsPlugin.logEvent} needs for one row. */
interface LogEventParams {
  eventType: AnalyticsEventType;
  invocationContext: InvocationContext;
  rawContent?: unknown;
  data?: AnalyticsEventData;
}

/** A 32-hex-character identifier, the shape OpenTelemetry uses for a trace id. */
function newTraceId(): string {
  return randomUUID().replaceAll('-', '');
}

/** A 16-hex-character identifier, the shape OpenTelemetry uses for a span id. */
function newSpanId(): string {
  return newTraceId().slice(0, 16);
}

/** The ambient OpenTelemetry trace id, when a valid span is active. */
function ambientTraceId(): string | undefined {
  const context = trace.getActiveSpan()?.spanContext();
  return context !== undefined && isSpanContextValid(context)
    ? context.traceId
    : undefined;
}

/** The agent's instruction, when it is a plain string. */
function agentInstruction(agent: BaseAgent): string {
  const instruction = (agent as {instruction?: unknown}).instruction;
  return typeof instruction === 'string' ? instruction : '';
}

/** Captures the generation config and request labels into row attributes. */
function requestAttributes(llmRequest: LlmRequest): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  const config = llmRequest.config;
  if (config !== undefined) {
    const llmConfig: Record<string, unknown> = {};
    for (const [field, column] of LOGGED_GENERATION_CONFIG_KEYS) {
      const value = config[field];
      if (value !== undefined) {
        llmConfig[column] = value;
      }
    }
    if (Object.keys(llmConfig).length > 0) {
      attributes['llm_config'] = llmConfig;
    }
    if (config.labels !== undefined) {
      attributes['labels'] = config.labels;
    }
  }
  const tools = Object.keys(llmRequest.toolsDict);
  if (tools.length > 0) {
    attributes['tools'] = tools;
  }
  return attributes;
}

/** The token counts adk-python records under `content.usage`. */
function usageCounts(
  llmResponse: LlmResponse,
): Record<string, number> | undefined {
  const usage = llmResponse.usageMetadata;
  if (usage === undefined) {
    return undefined;
  }
  return {
    prompt: usage.promptTokenCount ?? 0,
    completion: usage.candidatesTokenCount ?? 0,
    total: usage.totalTokenCount ?? 0,
  };
}

/** The `latency_ms` object, or null when neither measurement is available. */
function buildLatency(data: AnalyticsEventData): Record<string, number> | null {
  const latency: Record<string, number> = {};
  if (data.latencyMs !== undefined) {
    latency['total_ms'] = data.latencyMs;
  }
  if (data.timeToFirstTokenMs !== undefined) {
    latency['time_to_first_token_ms'] = data.timeToFirstTokenMs;
  }
  return Object.keys(latency).length > 0 ? latency : null;
}

/** Fills every {@link BigQueryLoggerConfig} default in. */
function resolveConfig(config: BigQueryLoggerConfig): ResolvedConfig {
  return {
    enabled: config.enabled ?? true,
    eventAllowlist: config.eventAllowlist,
    eventDenylist: config.eventDenylist,
    maxContentLength: config.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH,
    logMultiModalContent: config.logMultiModalContent ?? true,
    contentFormatter: config.contentFormatter,
    logSessionMetadata: config.logSessionMetadata ?? true,
    customTags: config.customTags ?? {},
    flushOnRunEnd: config.flushOnRunEnd ?? true,
  };
}

/**
 * Streams agent lifecycle events into a BigQuery table so that agent
 * behaviour, cost and failures can be queried in SQL.
 *
 * Each callback the runner fires becomes one row of `<project>.<dataset>.
 * <table>`: the user message, the invocation, each agent turn, each model
 * request and response, each tool call, and each state delta. The table is
 * created on first use, partitioned by day on `timestamp` and clustered by the
 * configured fields; the **dataset must already exist**. Column names, types
 * and values match `google/adk-python`'s plugin of the same name, so one
 * dataset can hold rows from both SDKs.
 *
 * The plugin never breaks an agent run. Every callback swallows its own
 * failures, every credential-bearing key is redacted before a row is written,
 * and the row queue, the span bookkeeping and the sanitizer are all bounded.
 *
 * `@google-cloud/bigquery` is an optional peer dependency, loaded on the first
 * row. When it is missing the row is counted in {@link getDropStats} and the
 * run continues.
 *
 * Example:
 * ```typescript
 * const analytics = new BigQueryAgentAnalyticsPlugin({
 *   projectId: 'my-project',
 *   datasetId: 'agent_analytics',
 * });
 * const runner = new Runner({appName, agent, sessionService, plugins: [analytics]});
 * // ... run agents ...
 * await analytics.shutdown();
 * ```
 */
export class BigQueryAgentAnalyticsPlugin extends BasePlugin {
  private readonly config: ResolvedConfig;
  private readonly writer: BigQueryRowWriter;
  private readonly spanStacks = new Map<string, SpanRecord[]>();
  private shutDown = false;

  constructor(options: BigQueryAgentAnalyticsPluginOptions) {
    super(PLUGIN_NAME);
    const config = options.config ?? {};
    this.config = resolveConfig(config);
    this.writer = new BigQueryRowWriter({
      projectId: options.projectId,
      datasetId: options.datasetId,
      tableId: options.tableId ?? DEFAULT_TABLE_ID,
      location: options.location ?? DEFAULT_LOCATION,
      clusteringFields: config.clusteringFields ?? DEFAULT_CLUSTERING_FIELDS,
      batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
      flushIntervalMs:
        config.batchFlushIntervalMs ?? DEFAULT_BATCH_FLUSH_INTERVAL_MS,
      shutdownTimeoutMs:
        config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      queueMaxSize: config.queueMaxSize ?? DEFAULT_QUEUE_MAX_SIZE,
    });
  }

  /**
   * Returns how many rows were lost or degraded, keyed by reason. The counters
   * survive {@link shutdown}, so a host can export them after the run.
   */
  getDropStats(): Record<string, number> {
    return this.writer.getDropStats();
  }

  /** Writes everything queued and waits for the inserts to settle. */
  async flush(): Promise<void> {
    return this.writer.flush();
  }

  /**
   * Drains the queue, releases the flush timer and makes every later callback
   * a no-op. Safe to call more than once.
   */
  async shutdown(): Promise<void> {
    if (this.shutDown) {
      return;
    }
    this.shutDown = true;
    this.spanStacks.clear();
    await this.writer.shutdown();
  }

  override async onUserMessageCallback(params: {
    invocationContext: InvocationContext;
    userMessage: Content;
  }): Promise<undefined> {
    return this.safe('onUserMessageCallback', async () => {
      this.ensureInvocationSpan(params.invocationContext.invocationId);
      await this.logEvent({
        eventType: AnalyticsEventType.USER_MESSAGE_RECEIVED,
        invocationContext: params.invocationContext,
        rawContent: params.userMessage,
      });
      await this.logUserMessageCompletions(
        params.invocationContext,
        params.userMessage,
      );
    });
  }

  override async beforeRunCallback(params: {
    invocationContext: InvocationContext;
  }): Promise<undefined> {
    return this.safe('beforeRunCallback', async () => {
      this.ensureInvocationSpan(params.invocationContext.invocationId);
      await this.logEvent({
        eventType: AnalyticsEventType.INVOCATION_STARTING,
        invocationContext: params.invocationContext,
      });
    });
  }

  override async afterRunCallback(params: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    await this.safe('afterRunCallback', async () => {
      const {invocationContext} = params;
      const invocationId = invocationContext.invocationId;
      // The trace id is read before the pop, so INVOCATION_COMPLETED shares
      // the trace of every earlier row in this invocation.
      const traceIdOverride = this.traceIdFor(invocationId);
      const popped = this.popSpan(invocationId);
      const parentSpanIdOverride = this.currentSpan(invocationId)?.spanId;
      this.spanStacks.delete(invocationId);
      await this.logEvent({
        eventType: AnalyticsEventType.INVOCATION_COMPLETED,
        invocationContext,
        data: {
          traceIdOverride,
          spanIdOverride: popped?.spanId,
          parentSpanIdOverride,
          latencyMs: elapsedSince(popped),
        },
      });
      if (this.config.flushOnRunEnd) {
        await this.writer.flush();
      }
    });
  }

  override async beforeAgentCallback(params: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<undefined> {
    return this.safe('beforeAgentCallback', async () => {
      const invocationContext = params.callbackContext.invocationContext;
      this.pushSpan(invocationContext.invocationId, SpanKind.AGENT);
      await this.logEvent({
        eventType: AnalyticsEventType.AGENT_STARTING,
        invocationContext,
        rawContent: agentInstruction(params.agent),
      });
    });
  }

  override async afterAgentCallback(params: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<undefined> {
    return this.safe('afterAgentCallback', async () => {
      const invocationContext = params.callbackContext.invocationContext;
      const popped = this.popSpan(
        invocationContext.invocationId,
        SpanKind.AGENT,
      );
      await this.logEvent({
        eventType: AnalyticsEventType.AGENT_COMPLETED,
        invocationContext,
        data: this.afterPopData(invocationContext.invocationId, popped),
      });
    });
  }

  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<undefined> {
    return this.safe('beforeModelCallback', async () => {
      const invocationContext = params.callbackContext.invocationContext;
      const invocationId = invocationContext.invocationId;
      // A request short-circuited by another plugin never reaches
      // afterModelCallback, so its span would otherwise stay on the stack.
      this.popSpan(invocationId, SpanKind.LLM_REQUEST);
      this.pushSpan(invocationId, SpanKind.LLM_REQUEST);
      await this.logEvent({
        eventType: AnalyticsEventType.LLM_REQUEST,
        invocationContext,
        rawContent: params.llmRequest,
        data: {
          model: params.llmRequest.model,
          extraAttributes: requestAttributes(params.llmRequest),
        },
      });
    });
  }

  override async afterModelCallback(params: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<undefined> {
    return this.safe('afterModelCallback', async () => {
      const {llmResponse} = params;
      const invocationContext = params.callbackContext.invocationContext;
      const invocationId = invocationContext.invocationId;
      const isPartial = llmResponse.partial === true;
      const open = this.currentSpan(invocationId);
      if (open !== undefined && open.firstTokenTimeMs === undefined) {
        open.firstTokenTimeMs = Date.now();
      }
      // A streaming response keeps its span open until the final chunk, so
      // every chunk shares the request's span id.
      const popped = isPartial
        ? undefined
        : this.popSpan(invocationId, SpanKind.LLM_REQUEST);
      const span = popped ?? open;
      const content: Record<string, unknown> = {};
      if (llmResponse.content !== undefined) {
        content['response'] = formatContentSummary(llmResponse.content);
      }
      const usage = usageCounts(llmResponse);
      if (usage !== undefined) {
        content['usage'] = usage;
      }
      await this.logEvent({
        eventType: AnalyticsEventType.LLM_RESPONSE,
        invocationContext,
        rawContent: Object.keys(content).length > 0 ? content : undefined,
        data: {
          spanIdOverride: popped?.spanId,
          parentSpanIdOverride:
            popped === undefined
              ? undefined
              : this.currentSpan(invocationId)?.spanId,
          latencyMs: elapsedSince(span),
          timeToFirstTokenMs: timeToFirstToken(span),
          modelVersion: llmResponse.modelVersion,
          usageMetadata: llmResponse.usageMetadata,
          finishReason: isPartial ? undefined : llmResponse.finishReason,
          errorMessage: isPartial
            ? undefined
            : (llmResponse.errorMessage ?? llmResponse.errorCode),
        },
      });
    });
  }

  override async onModelErrorCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
    error: Error;
  }): Promise<undefined> {
    return this.safe('onModelErrorCallback', async () => {
      const invocationContext = params.callbackContext.invocationContext;
      const invocationId = invocationContext.invocationId;
      const popped = this.popSpan(invocationId, SpanKind.LLM_REQUEST);
      await this.logEvent({
        eventType: AnalyticsEventType.LLM_ERROR,
        invocationContext,
        data: {
          ...this.afterPopData(invocationId, popped),
          status: AnalyticsStatus.ERROR,
          errorMessage: formatError(params.error),
        },
      });
    });
  }

  override async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<undefined> {
    return this.safe('beforeToolCallback', async () => {
      const invocationContext = params.toolContext.invocationContext;
      this.pushSpan(invocationContext.invocationId, SpanKind.TOOL);
      await this.logEvent({
        eventType: AnalyticsEventType.TOOL_STARTING,
        invocationContext,
        rawContent: {tool: params.tool.name, args: params.toolArgs},
      });
    });
  }

  override async afterToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<undefined> {
    return this.safe('afterToolCallback', async () => {
      const invocationContext = params.toolContext.invocationContext;
      const invocationId = invocationContext.invocationId;
      const popped = this.popSpan(invocationId, SpanKind.TOOL);
      await this.logEvent({
        eventType: AnalyticsEventType.TOOL_COMPLETED,
        invocationContext,
        rawContent: {tool: params.tool.name, result: params.result},
        data: this.afterPopData(invocationId, popped),
      });
    });
  }

  override async onToolErrorCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    error: Error;
  }): Promise<undefined> {
    return this.safe('onToolErrorCallback', async () => {
      const invocationContext = params.toolContext.invocationContext;
      const invocationId = invocationContext.invocationId;
      const popped = this.popSpan(invocationId, SpanKind.TOOL);
      await this.logEvent({
        eventType: AnalyticsEventType.TOOL_ERROR,
        invocationContext,
        rawContent: {tool: params.tool.name, args: params.toolArgs},
        data: {
          ...this.afterPopData(invocationId, popped),
          status: AnalyticsStatus.ERROR,
          errorMessage: formatError(params.error),
        },
      });
    });
  }

  override async onEventCallback(params: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<undefined> {
    return this.safe('onEventCallback', async () => {
      const {invocationContext, event} = params;
      await this.logStateDelta(invocationContext, event);
      await this.logAgentTransfer(invocationContext, event);
      await this.logPausedCalls(invocationContext, event);
      await this.logHitlCompletions(invocationContext, event);
      await this.logAgentResponse(invocationContext, event);
    });
  }

  /** Writes an `AGENT_TRANSFER` row when the event handed control to a peer. */
  private async logAgentTransfer(
    invocationContext: InvocationContext,
    event: Event,
  ): Promise<void> {
    const toAgent = event.actions.transferToAgent;
    if (toAgent === undefined) {
      return;
    }
    await this.logEvent({
      eventType: AnalyticsEventType.AGENT_TRANSFER,
      invocationContext,
      rawContent: {from_agent: event.author, to_agent: toAgent},
      data: {sourceEvent: event},
    });
  }

  /**
   * Writes a row for every call the event leaves pending: a `HITL_*_REQUEST`
   * for each framework request, and a `TOOL_PAUSED` for each long-running call
   * id. A framework request is both, so it gets both rows. `TOOL_PAUSED` is
   * the row a completion pairs with, and its `pause_kind` says what the run is
   * waiting for, which is why a query counting pauses sees framework requests
   * too.
   */
  private async logPausedCalls(
    invocationContext: InvocationContext,
    event: Event,
  ): Promise<void> {
    const calls = getFunctionCalls(event);
    for (const call of calls) {
      const mapping = hitlMappingFor(call.name);
      if (mapping === undefined) {
        continue;
      }
      await this.logEvent({
        eventType: mapping.request,
        invocationContext,
        rawContent: {tool: call.name ?? null, args: call.args ?? null},
        data: {
          sourceEvent: event,
          extraAttributes: pauseAttributes(mapping.pauseKind, call.id),
        },
      });
    }
    for (const id of event.longRunningToolIds ?? []) {
      const call = calls.find((candidate) => candidate.id === id);
      if (hitlMappingFor(call?.name) !== undefined) {
        continue;
      }
      if (call === undefined) {
        logger.warn(UNMATCHED_LONG_RUNNING_ID_LOG);
      }
      await this.logEvent({
        eventType: AnalyticsEventType.TOOL_PAUSED,
        invocationContext,
        rawContent: {tool: call?.name ?? null, args: call?.args ?? null},
        data: {
          sourceEvent: event,
          extraAttributes: pauseAttributes(TOOL_PAUSE_KIND, id),
        },
      });
    }
  }

  /** Writes a `HITL_*_REQUEST_COMPLETED` row per answered framework request. */
  private async logHitlCompletions(
    invocationContext: InvocationContext,
    event: Event,
  ): Promise<void> {
    for (const response of getFunctionResponses(event)) {
      const mapping = hitlMappingFor(response.name);
      if (mapping === undefined) {
        continue;
      }
      await this.logEvent({
        eventType: mapping.completed,
        invocationContext,
        rawContent: {
          tool: response.name ?? null,
          result: response.response ?? null,
        },
        data: {
          sourceEvent: event,
          extraAttributes: pauseAttributes(mapping.pauseKind, response.id),
        },
      });
    }
  }

  /**
   * Writes the row that closes a pause a client answered in its message: the
   * `HITL_*_REQUEST_COMPLETED` for a framework request, otherwise the
   * `TOOL_COMPLETED` of a long-running tool.
   */
  private async logUserMessageCompletions(
    invocationContext: InvocationContext,
    userMessage: Content,
  ): Promise<void> {
    for (const part of userMessage.parts ?? []) {
      const response = part.functionResponse;
      if (response === undefined) {
        continue;
      }
      const mapping = hitlMappingFor(response.name);
      await this.logEvent({
        eventType: mapping?.completed ?? AnalyticsEventType.TOOL_COMPLETED,
        invocationContext,
        rawContent: {
          tool: response.name ?? null,
          result: response.response ?? null,
        },
        data: {
          extraAttributes: pauseAttributes(
            mapping?.pauseKind ?? TOOL_PAUSE_KIND,
            response.id,
          ),
        },
      });
    }
  }

  /** Writes a `STATE_DELTA` row when the event changed session state. */
  private async logStateDelta(
    invocationContext: InvocationContext,
    event: Event,
  ): Promise<void> {
    const stateDelta = event.actions.stateDelta;
    if (Object.keys(stateDelta).length === 0) {
      return;
    }
    await this.logEvent({
      eventType: AnalyticsEventType.STATE_DELTA,
      invocationContext,
      data: {sourceEvent: event, extraAttributes: {state_delta: stateDelta}},
    });
  }

  /**
   * Writes an `AGENT_RESPONSE` row for a final, visible text answer.
   *
   * Skipped for a partial event, a function call or response, a long-running
   * tool pause, and an event whose parts are all thoughts, all empty, or not
   * text at all — those are internal steps, not the answer a user saw.
   */
  private async logAgentResponse(
    invocationContext: InvocationContext,
    event: Event,
  ): Promise<void> {
    const parts = event.content?.parts;
    if (
      parts === undefined ||
      parts.length === 0 ||
      event.partial === true ||
      (event.longRunningToolIds?.length ?? 0) > 0 ||
      getFunctionCalls(event).length > 0 ||
      getFunctionResponses(event).length > 0 ||
      !isFinalResponse(event)
    ) {
      return;
    }
    const visible = parts.filter((part) => part.text && part.thought !== true);
    if (visible.length === 0) {
      return;
    }
    await this.logEvent({
      eventType: AnalyticsEventType.AGENT_RESPONSE,
      invocationContext,
      rawContent: {
        response: formatContentSummary({
          role: event.content?.role,
          parts: visible,
        }),
      },
      data: {
        sourceEvent: event,
        extraAttributes: {
          source_event_id: event.id,
          source_event_author: event.author,
          source_event_branch: event.branch,
        },
      },
    });
  }

  /**
   * Runs `body`, turning any failure into a log line. Analytics must never
   * break an agent run, so every callback goes through here and every callback
   * resolves `undefined`.
   */
  private async safe(
    callbackName: string,
    body: () => Promise<void>,
  ): Promise<undefined> {
    try {
      await body();
    } catch (err: unknown) {
      logger.error(
        `${PLUGIN_NAME}.${callbackName} failed: ${formatError(err)}`,
      );
    }
    return undefined;
  }

  /** Builds one row and hands it to the writer. */
  private async logEvent(params: LogEventParams): Promise<void> {
    const {eventType, invocationContext, rawContent, data = {}} = params;
    if (!this.config.enabled || this.shutDown || !this.isLogged(eventType)) {
      return;
    }
    const invocationId = invocationContext.invocationId;
    const parsed = this.parseContent(eventType, rawContent);
    const attributes = recursiveSmartTruncate(
      this.buildAttributes(invocationContext, data),
      this.config.maxContentLength,
    );
    const error =
      data.errorMessage === undefined
        ? undefined
        : recursiveSmartTruncate(
            data.errorMessage,
            this.config.maxContentLength,
          );
    const latency = buildLatency(data);
    const row: AnalyticsRow = {
      timestamp: new Date().toISOString(),
      event_id: newTraceId(),
      event_type: eventType,
      agent: invocationContext.agent?.name ?? data.sourceEvent?.author ?? null,
      session_id: invocationContext.session.id,
      invocation_id: invocationId,
      user_id: invocationContext.userId,
      trace_id: data.traceIdOverride ?? this.traceIdFor(invocationId),
      span_id:
        data.spanIdOverride ?? this.currentSpan(invocationId)?.spanId ?? null,
      parent_span_id:
        data.parentSpanIdOverride ?? this.parentSpanIdFor(invocationId) ?? null,
      content: parsed.payload === null ? null : JSON.stringify(parsed.payload),
      content_parts: this.config.logMultiModalContent ? parsed.parts : [],
      attributes: JSON.stringify(attributes.value),
      latency_ms: latency === null ? null : JSON.stringify(latency),
      status: data.status ?? AnalyticsStatus.OK,
      error_message: error === undefined ? null : String(error.value),
      is_truncated:
        parsed.truncated || attributes.truncated || error?.truncated === true,
    };
    await this.writer.enqueue(row);
  }

  /** Whether `eventType` passes the denylist and the allowlist. */
  private isLogged(eventType: AnalyticsEventType): boolean {
    const {eventAllowlist, eventDenylist} = this.config;
    if (eventDenylist?.includes(eventType) === true) {
      return false;
    }
    return eventAllowlist === undefined || eventAllowlist.includes(eventType);
  }

  /**
   * Applies the configured formatter, then sanitizes the payload. Both stages
   * fail closed: the row is still written, carrying a sentinel instead of a
   * payload that could not be handled safely.
   */
  private parseContent(
    eventType: AnalyticsEventType,
    rawContent: unknown,
  ): ParsedAnalyticsContent {
    let payload = rawContent;
    const formatter = this.config.contentFormatter;
    if (formatter !== undefined) {
      try {
        payload = formatter(rawContent, eventType);
      } catch {
        this.writer.countDrop(AnalyticsDropReason.FORMATTER_FAILED);
        logger.warn(FORMATTER_FAILED_LOG);
        payload = FORMATTER_FAILED;
      }
    }
    try {
      return parseAnalyticsContent(payload, this.config.maxContentLength);
    } catch {
      this.writer.countDrop(AnalyticsDropReason.CONTENT_PARSE_FAILED);
      logger.warn(CONTENT_PARSE_FAILED_LOG);
      return {payload: CONTENT_PARSE_FAILED, parts: [], truncated: true};
    }
  }

  /** Builds the `attributes` column's object, before its final sanitize pass. */
  private buildAttributes(
    invocationContext: InvocationContext,
    data: AnalyticsEventData,
  ): Record<string, unknown> {
    const attributes: Record<string, unknown> = {...data.extraAttributes};
    attributes['root_agent_name'] =
      invocationContext.agent?.rootAgent.name ?? null;
    if (data.model !== undefined) {
      attributes['model'] = data.model;
    }
    if (data.modelVersion !== undefined) {
      attributes['model_version'] = data.modelVersion;
    }
    if (data.usageMetadata !== undefined) {
      attributes['usage_metadata'] = data.usageMetadata;
    }
    if (data.finishReason !== undefined) {
      attributes['finish_reason'] = data.finishReason;
    }
    if (this.config.logSessionMetadata) {
      attributes['session_metadata'] = {
        session_id: invocationContext.session.id,
        app_name: invocationContext.appName,
        user_id: invocationContext.userId,
        branch: invocationContext.branch ?? null,
      };
    }
    if (Object.keys(this.config.customTags).length > 0) {
      attributes['custom_tags'] = this.config.customTags;
    }
    return attributes;
  }

  /** The span id and latency overrides a callback uses after popping a span. */
  private afterPopData(
    invocationId: string,
    popped: SpanRecord | undefined,
  ): AnalyticsEventData {
    return {
      spanIdOverride: popped?.spanId,
      parentSpanIdOverride: this.currentSpan(invocationId)?.spanId,
      latencyMs: elapsedSince(popped),
    };
  }

  /** Seeds the invocation's root span, unless one already exists. */
  private ensureInvocationSpan(invocationId: string): void {
    if (this.stackFor(invocationId).length > 0) {
      return;
    }
    this.pushSpan(invocationId, SpanKind.INVOCATION);
  }

  /**
   * Returns the invocation's span stack, creating it and evicting the oldest
   * tracked invocations once the cap is reached.
   */
  private stackFor(invocationId: string): SpanRecord[] {
    const existing = this.spanStacks.get(invocationId);
    if (existing !== undefined) {
      return existing;
    }
    for (const oldest of this.spanStacks.keys()) {
      if (this.spanStacks.size < MAX_TRACKED_INVOCATIONS) {
        break;
      }
      this.spanStacks.delete(oldest);
    }
    const stack: SpanRecord[] = [];
    this.spanStacks.set(invocationId, stack);
    return stack;
  }

  /**
   * Pushes a span. Its trace id comes from the span below it, then from the
   * ambient OpenTelemetry span, then from a fresh value — so every row of one
   * invocation shares one trace id.
   */
  private pushSpan(invocationId: string, kind: SpanKind): SpanRecord {
    const stack = this.stackFor(invocationId);
    const record: SpanRecord = {
      spanId: newSpanId(),
      traceId: stack.at(-1)?.traceId ?? ambientTraceId() ?? newTraceId(),
      startTimeMs: Date.now(),
      kind,
    };
    stack.push(record);
    return record;
  }

  /**
   * Pops the top span, leaving the stack untouched when `expectedKind` does
   * not match. Error callbacks pass a kind so they never pop a span that
   * belongs to an enclosing agent or invocation.
   */
  private popSpan(
    invocationId: string,
    expectedKind?: SpanKind,
  ): SpanRecord | undefined {
    const stack = this.spanStacks.get(invocationId) ?? [];
    const top = stack.at(-1);
    if (top === undefined) {
      return undefined;
    }
    if (expectedKind !== undefined && top.kind !== expectedKind) {
      return undefined;
    }
    stack.pop();
    return top;
  }

  /** The invocation's innermost open span. */
  private currentSpan(invocationId: string): SpanRecord | undefined {
    return this.spanStacks.get(invocationId)?.at(-1);
  }

  /** The span enclosing the invocation's innermost open span. */
  private parentSpanIdFor(invocationId: string): string | undefined {
    return this.spanStacks.get(invocationId)?.at(-2)?.spanId;
  }

  /** The invocation's trace id, falling back to the ambient span then its id. */
  private traceIdFor(invocationId: string): string {
    return (
      this.currentSpan(invocationId)?.traceId ??
      ambientTraceId() ??
      invocationId
    );
  }
}

/**
 * The `attributes.adk` envelope a paused call and its completion share, so one
 * query pairs them on `function_call_id`.
 */
function pauseAttributes(
  pauseKind: string,
  functionCallId: string | undefined,
): Record<string, unknown> {
  return {
    adk: {pause_kind: pauseKind, function_call_id: functionCallId ?? null},
  };
}

/** Milliseconds since `span` started, or undefined when there is no span. */
function elapsedSince(span: SpanRecord | undefined): number | undefined {
  return span === undefined ? undefined : Date.now() - span.startTimeMs;
}

/** Milliseconds from a span's start to its first token, when one was seen. */
function timeToFirstToken(span: SpanRecord | undefined): number | undefined {
  return span?.firstTokenTimeMs === undefined
    ? undefined
    : span.firstTokenTimeMs - span.startTimeMs;
}
