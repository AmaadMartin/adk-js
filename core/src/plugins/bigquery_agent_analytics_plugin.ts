/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content} from '@google/genai';
import type {BaseAgent} from '../agents/base_agent.js';
import type {Context} from '../agents/context.js';
import type {InvocationContext} from '../agents/invocation_context.js';
import {Event, isFinalResponse} from '../events/event.js';
import type {LlmRequest} from '../models/llm_request.js';
import {
  getFunctionCalls,
  getFunctionResponses,
  type LlmResponse,
} from '../models/llm_response.js';
import type {BaseTool} from '../tools/base_tool.js';
import {formatError} from '../utils/error_utils.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {
  recursiveSmartTruncate,
  sanitizeErrorText,
} from '../utils/sanitize_utils.js';
import type {BaseNode} from '../workflow/base_node.js';
import type {NodeContext} from '../workflow/node_context.js';
import {isNodeErrorEvent} from '../workflow/node_error_event.js';
import {BasePlugin} from './base_plugin.js';
import {
  BigQueryAgentAnalyticsPluginOptions,
  ResolvedConfig,
  resolvePluginOptions,
} from './bigquery_analytics_config.js';
import {
  AnalyticsOffload,
  formatContentSummary,
  parseAnalyticsContent,
  ParsedAnalyticsContent,
} from './bigquery_analytics_content.js';
import {GcsOffloader} from './bigquery_analytics_offloader.js';
import {
  agentInstruction,
  AnalyticsEventData,
  buildAttributes,
  buildLatency,
  pauseKeys,
  requestAttributes,
  toolContent,
  usageCounts,
} from './bigquery_analytics_row.js';
import {
  AnalyticsEventType,
  AnalyticsNode,
  AnalyticsRow,
  AnalyticsStatus,
  hitlMappingFor,
  parseNodeRunIds,
  TOOL_PAUSE_KIND,
} from './bigquery_analytics_schema.js';
import {
  elapsedSince,
  newHexId,
  SpanKind,
  SpanRecord,
  SpanTracker,
  timeToFirstToken,
} from './bigquery_analytics_spans.js';
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
 * Builds the content offloader, or returns undefined when nothing would read
 * what it uploads.
 *
 * `content_parts` holds the object reference, so an upload would cost storage
 * and leave no row pointing at it whenever that column is empty. Both the
 * denylist and `logMultiModalContent` empty it. adk-python guards only the
 * denylist, because it has no second way to drop the column.
 */
function createOffloader(
  projectId: string,
  config: ResolvedConfig,
): GcsOffloader | undefined {
  const {gcsBucketName, deniedColumns, logMultiModalContent} = config;
  if (
    gcsBucketName === undefined ||
    deniedColumns.has('content_parts') ||
    !logMultiModalContent
  ) {
    return undefined;
  }
  return new GcsOffloader({projectId, bucketName: gcsBucketName});
}

/** Everything {@link BigQueryAgentAnalyticsPlugin.logEvent} needs for one row. */
interface LogEventParams {
  eventType: AnalyticsEventType;
  invocationContext: InvocationContext;
  rawContent?: unknown;
  data?: AnalyticsEventData;
}

/**
 * Plugins that have not been shut down, drained when the event loop empties.
 *
 * This is the backstop for a host that never calls `shutdown()` and turns
 * `flushOnRunEnd` off, and it mirrors the set of live plugins adk-python
 * drains from its `atexit` handler.
 *
 * One listener serves every plugin. Registering one each would exceed Node's
 * ten-listener warning threshold in a host that builds more than ten, and
 * report a leak that is not there.
 */
const pendingDrain = new Set<BigQueryAgentAnalyticsPlugin>();

/**
 * Drains every live plugin.
 *
 * `beforeExit` is the only exit event that can await an insert, and a listener
 * on it does not hold the loop open, so the process still ends once the drain
 * settles. It does not fire on an explicit `process.exit()` or on a fatal
 * signal, neither of which any asynchronous flush survives.
 */
function drainPendingBeforeExit(): void {
  void Promise.all([...pendingDrain].map((plugin) => plugin.shutdown()));
}

/** Registers `plugin` for the exit drain, installing the listener once. */
function trackUntilShutdown(plugin: BigQueryAgentAnalyticsPlugin): void {
  if (pendingDrain.size === 0) {
    process.on('beforeExit', drainPendingBeforeExit);
  }
  pendingDrain.add(plugin);
}

/** Drops `plugin` from the exit drain, releasing the listener with the last. */
function forgetOnShutdown(plugin: BigQueryAgentAnalyticsPlugin): void {
  pendingDrain.delete(plugin);
  if (pendingDrain.size === 0) {
    process.removeListener('beforeExit', drainPendingBeforeExit);
  }
}

/**
 * Streams agent lifecycle events into a BigQuery table so that agent
 * behaviour, cost and failures can be queried in SQL.
 *
 * Each callback the runner fires becomes one row of `<project>.<dataset>.
 * <table>`: the user message, the invocation, each agent turn, each model
 * request and response, each tool call, and each state delta. The table is
 * created on first use, partitioned by day on `timestamp` and clustered by the
 * configured fields, and the dataset is created too if absent. Column names, types
 * and values match `google/adk-python`'s plugin of the same name, so one
 * dataset can hold rows from both SDKs.
 *
 * The plugin never breaks an agent run. Every callback swallows its own
 * failures, every credential-bearing key is redacted before a row is written,
 * and the row queue, the span bookkeeping and the sanitizer are all bounded.
 *
 * `@google-cloud/bigquery` and `@google-cloud/bigquery-storage` are optional
 * peer dependencies, loaded on the first row. When one is missing the row is
 * counted in {@link getDropStats} and the run continues.
 *
 * One departure from adk-python is deliberate: the `AGENT_ERROR` and
 * `INVOCATION_ERROR` event types are declared but never written, because
 * adk-js `BasePlugin` has no `onAgentErrorCallback` or `onRunErrorCallback` to
 * write them from.
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
@experimental
export class BigQueryAgentAnalyticsPlugin extends BasePlugin {
  private readonly config: ResolvedConfig;
  private readonly writer: BigQueryRowWriter;
  private readonly offloader?: GcsOffloader;
  private readonly spans = new SpanTracker();
  private shutDown = false;
  private shutdownPromise?: Promise<void>;

  constructor(options: BigQueryAgentAnalyticsPluginOptions) {
    super(PLUGIN_NAME);
    const resolved = resolvePluginOptions(options);
    this.config = resolved.config;
    this.writer = new BigQueryRowWriter(resolved.writer);
    this.offloader = createOffloader(options.projectId, resolved.config);
    trackUntilShutdown(this);
  }

  /**
   * Returns how many rows were lost or degraded, keyed by reason. The counters
   * survive {@link shutdown}, so a host can export them after the run.
   *
   * A reason names a loss incident, not always a lost row.
   * `formatter_failed` and `content_parse_failed` mean the row was written
   * with a sentinel in place of its content. Every other reason means the row
   * was never written.
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
   * a no-op. Safe to call more than once: a second caller waits on the first
   * call's drain instead of returning while rows are still in flight.
   */
  async shutdown(): Promise<void> {
    this.shutdownPromise ??= this.drain();
    return this.shutdownPromise;
  }

  /** Refuses further rows, then waits for the queued ones to settle. */
  private async drain(): Promise<void> {
    this.shutDown = true;
    forgetOnShutdown(this);
    this.spans.clear();
    await this.writer.shutdown();
  }

  override async onUserMessageCallback(params: {
    invocationContext: InvocationContext;
    userMessage: Content;
  }): Promise<undefined> {
    return this.safe('onUserMessageCallback', async () => {
      this.spans.ensureInvocation(params.invocationContext.invocationId);
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
      this.spans.ensureInvocation(params.invocationContext.invocationId);
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
      const traceIdOverride = this.spans.traceId(invocationId);
      const popped = this.spans.pop(invocationId);
      const parentSpanIdOverride = this.spans.current(invocationId)?.spanId;
      this.spans.forget(invocationId);
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
        await this.writer.flushWithinTimeout();
      }
    });
  }

  override async beforeAgentCallback(params: {
    agent: BaseAgent;
    callbackContext: Context;
  }): Promise<undefined> {
    return this.safe('beforeAgentCallback', async () => {
      const invocationContext = params.callbackContext.invocationContext;
      this.spans.push(invocationContext.invocationId, SpanKind.AGENT);
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
      const popped = this.spans.pop(
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

  override async afterNodeCallback(params: {
    node: BaseNode;
    nodeContext: NodeContext;
    output: unknown;
  }): Promise<undefined> {
    return this.safe('afterNodeCallback', async () => {
      const {node, nodeContext} = params;
      await this.logEvent({
        eventType: AnalyticsEventType.NODE_OUTPUT,
        invocationContext: nodeContext.invocationContext,
        rawContent: {node: node.name, output: params.output},
        data: {
          adk: {
            node: {
              path: nodeContext.nodePath,
              // The context knows this run's id; only the parent's is derived.
              run_id: nodeContext.runId,
              parent_run_id: parseNodeRunIds(nodeContext.nodePath)
                .parent_run_id,
            } satisfies AnalyticsNode,
          },
        },
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
      this.spans.pop(invocationId, SpanKind.LLM_REQUEST);
      this.spans.push(invocationId, SpanKind.LLM_REQUEST);
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
      const open = this.spans.current(invocationId);
      if (open !== undefined && open.firstTokenTimeMs === undefined) {
        open.firstTokenTimeMs = Date.now();
      }
      // A streaming response keeps its span open until the final chunk, so
      // every chunk shares the request's span id.
      const popped = isPartial
        ? undefined
        : this.spans.pop(invocationId, SpanKind.LLM_REQUEST);
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
              : this.spans.current(invocationId)?.spanId,
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
      const popped = this.spans.pop(invocationId, SpanKind.LLM_REQUEST);
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
      this.spans.push(invocationContext.invocationId, SpanKind.TOOL);
      await this.logEvent({
        eventType: AnalyticsEventType.TOOL_STARTING,
        invocationContext,
        rawContent: toolContent(params, {args: params.toolArgs}),
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
      const popped = this.spans.pop(invocationId, SpanKind.TOOL);
      await this.logEvent({
        eventType: AnalyticsEventType.TOOL_COMPLETED,
        invocationContext,
        rawContent: toolContent(params, {result: params.result}),
        data: this.afterPopData(invocationId, popped),
      });
      // An agent that answers through a dedicated tool emits no plain-text
      // final event, so the onEventCallback path never sees the answer.
      if (this.config.finalResponseToolNames.includes(params.tool.name)) {
        await this.logEvent({
          eventType: AnalyticsEventType.AGENT_RESPONSE,
          invocationContext,
          rawContent: {response: params.toolArgs},
          data: {extraAttributes: {source_tool: params.tool.name}},
        });
      }
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
      const popped = this.spans.pop(invocationId, SpanKind.TOOL);
      await this.logEvent({
        eventType: AnalyticsEventType.TOOL_ERROR,
        invocationContext,
        rawContent: toolContent(params, {args: params.toolArgs}),
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
      await this.logAgentStateCheckpoint(invocationContext, event);
      await this.logNodeError(invocationContext, event);
      await this.logAgentTransfer(invocationContext, event);
      await this.logPausedCalls(invocationContext, event);
      await this.logHitlCompletions(invocationContext, event);
      await this.logAgentResponse(invocationContext, event);
    });
  }

  /**
   * Writes a `NODE_ERROR` row for a workflow node that failed.
   *
   * This is the only row a failed node produces: `afterNodeCallback` runs on
   * the success path alone, and the error event carries no state delta, no
   * transfer and no visible text, so every other `onEventCallback` branch
   * skips it. adk-python filters model failures out of this type by error
   * code; adk-js routes those to `onModelErrorCallback`, so the event type
   * already excludes them.
   */
  private async logNodeError(
    invocationContext: InvocationContext,
    event: Event,
  ): Promise<void> {
    if (!isNodeErrorEvent(event)) {
      return;
    }
    await this.logEvent({
      eventType: AnalyticsEventType.NODE_ERROR,
      invocationContext,
      rawContent: {error_code: event.errorCode ?? null},
      data: {
        sourceEvent: event,
        status: AnalyticsStatus.ERROR,
        errorMessage: event.errorMessage,
      },
    });
  }

  /**
   * Writes an `AGENT_STATE_CHECKPOINT` row for a resumable-workflow snapshot.
   *
   * `endOfAgent` alone is enough, so an agent that finishes without saving
   * state still marks where its run ended.
   */
  private async logAgentStateCheckpoint(
    invocationContext: InvocationContext,
    event: Event,
  ): Promise<void> {
    const {agentState, endOfAgent} = event.actions;
    if (agentState === undefined && endOfAgent !== true) {
      return;
    }
    await this.logEvent({
      eventType: AnalyticsEventType.AGENT_STATE_CHECKPOINT,
      invocationContext,
      rawContent: {
        agent_state: agentState ?? null,
        end_of_agent: endOfAgent === true,
      },
      data: {sourceEvent: event},
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
        rawContent: {tool: mapping.name, args: call.args ?? null},
        data: {
          sourceEvent: event,
          adk: pauseKeys(mapping.pauseKind, call.id),
        },
      });
    }
    for (const id of event.longRunningToolIds ?? []) {
      const call = calls.find((candidate) => candidate.id === id);
      if (call === undefined) {
        // The id is left out of the message: a model supplies it, so it is
        // untrusted like any other model output.
        logger.warn(
          'BigQuery analytics found a long-running tool id with no matching function call; writing the pause row without the call.',
        );
      }
      await this.logEvent({
        eventType: AnalyticsEventType.TOOL_PAUSED,
        invocationContext,
        rawContent: {tool: call?.name ?? null, args: call?.args ?? null},
        data: {
          sourceEvent: event,
          adk: pauseKeys(
            hitlMappingFor(call?.name)?.pauseKind ?? TOOL_PAUSE_KIND,
            id,
          ),
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
          tool: mapping.name,
          result: response.response ?? null,
        },
        data: {
          sourceEvent: event,
          adk: pauseKeys(mapping.pauseKind, response.id),
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
          adk: pauseKeys(mapping?.pauseKind ?? TOOL_PAUSE_KIND, response.id),
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
      // The flat trio duplicates `attributes.adk.*`, which stays canonical.
      // adk-python writes both, and `v_agent_response` reads the flat names.
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
    body: () => Promise<void> | void,
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

  /**
   * Builds one row and queues it.
   *
   * The queue is never waited on. The content offload is, when a bucket is
   * configured, because the row has to carry the URI the upload returns.
   */
  private async logEvent(params: LogEventParams): Promise<void> {
    const {eventType, invocationContext, rawContent, data = {}} = params;
    if (!this.config.enabled || !this.isLogged(eventType)) {
      return;
    }
    if (this.shutDown) {
      // A callback still in flight when shutdown began produces a row nothing
      // will write, so the loss is counted rather than left to the logs.
      this.writer.countDrop(AnalyticsDropReason.SHUTDOWN_RACE);
      return;
    }
    const invocationId = invocationContext.invocationId;
    // Every value the span stack and the clock supply is read before the
    // offload is awaited. A concurrent branch can push or pop a span during
    // that await, and the upload can take seconds, so reading them afterwards
    // would date the row late and correlate it against another branch's stack.
    const timestamp = new Date();
    const traceId = data.traceIdOverride ?? this.spans.traceId(invocationId);
    const spanId =
      data.spanIdOverride ?? this.spans.current(invocationId)?.spanId ?? null;
    const parentSpanId =
      data.parentSpanIdOverride ??
      this.spans.parentSpanId(invocationId) ??
      null;
    const parsed = await this.parseContent(eventType, rawContent, {
      traceId,
      spanId,
    });
    const attributes = recursiveSmartTruncate(
      buildAttributes(this.config, invocationContext, data),
      this.config.maxContentLength,
    );
    const error =
      data.errorMessage === undefined
        ? undefined
        : sanitizeErrorText(data.errorMessage, this.config.maxContentLength);
    const latency = buildLatency(data);
    const row: AnalyticsRow = {
      timestamp,
      event_id: newHexId(),
      event_type: eventType,
      agent: invocationContext.agent?.name ?? data.sourceEvent?.author ?? null,
      session_id: invocationContext.session.id,
      invocation_id: invocationId,
      user_id: invocationContext.userId,
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: parentSpanId,
      content: parsed.payload === null ? null : JSON.stringify(parsed.payload),
      content_parts: this.config.logMultiModalContent ? parsed.parts : [],
      attributes: JSON.stringify(attributes.value),
      latency_ms: latency === null ? null : JSON.stringify(latency),
      status: data.status ?? AnalyticsStatus.OK,
      error_message: error?.text ?? null,
      is_truncated:
        parsed.truncated || attributes.truncated || error?.truncated === true,
    };
    this.writer.enqueue(row);
  }

  /**
   * The Cloud Storage destination for this event's oversized parts, or
   * undefined when the plugin offloads nothing.
   *
   * An event with no open span gets no destination. A row may carry a null
   * `span_id`, but an object name may not, and an object no row can be traced
   * back to is worse than an inline sentinel.
   *
   * The span identifies the event and names its objects, so it is passed per
   * call: one parser instance serves concurrent events, and reading a mutable
   * field would let one event resume under another event's identity.
   */
  private buildOffload(span: {
    traceId: string;
    spanId: string | null;
  }): AnalyticsOffload | undefined {
    if (this.offloader === undefined || span.spanId === null) {
      return undefined;
    }
    return {
      offloader: this.offloader,
      traceId: span.traceId,
      spanId: span.spanId,
      connectionId: this.config.connectionId,
    };
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
  private async parseContent(
    eventType: AnalyticsEventType,
    rawContent: unknown,
    span: {traceId: string; spanId: string | null},
  ): Promise<ParsedAnalyticsContent> {
    let payload = rawContent;
    const formatter = this.config.contentFormatter;
    if (formatter !== undefined) {
      try {
        payload = formatter(rawContent, eventType);
      } catch {
        this.writer.countDrop(AnalyticsDropReason.FORMATTER_FAILED);
        // Constant message: the payload, the exception message and even a class
        // name can be attacker-supplied, and this plugin exists to keep such
        // values out of durable output.
        logger.warn(
          'BigQuery analytics content formatter failed; writing a sentinel instead of the content.',
        );
        payload = FORMATTER_FAILED;
      }
    }
    try {
      return await parseAnalyticsContent(
        payload,
        this.config.maxContentLength,
        this.buildOffload(span),
      );
    } catch {
      this.writer.countDrop(AnalyticsDropReason.CONTENT_PARSE_FAILED);
      // Constant message, for the same reason as the formatter failure above.
      logger.warn(
        'BigQuery analytics could not sanitize the content; writing a sentinel instead of it.',
      );
      return {payload: CONTENT_PARSE_FAILED, parts: [], truncated: true};
    }
  }

  /** The span id and latency overrides a callback uses after popping a span. */
  private afterPopData(
    invocationId: string,
    popped: SpanRecord | undefined,
  ): AnalyticsEventData {
    return {
      spanIdOverride: popped?.spanId,
      parentSpanIdOverride: this.spans.current(invocationId)?.spanId,
      latencyMs: elapsedSince(popped),
    };
  }
}
