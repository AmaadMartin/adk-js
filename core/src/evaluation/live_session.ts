/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {FunctionCall} from '@google/genai';
import {Modality} from '@google/genai';

import type {BaseAgent} from '../agents/base_agent.js';
import {isBaseAgent} from '../agents/base_agent.js';
import {Context} from '../agents/context.js';
import {handleFunctionCallsAsync} from '../agents/functions.js';
import {
  InvocationContext,
  newInvocationContextId,
} from '../agents/invocation_context.js';
import {LiveRequestQueue} from '../agents/live_request_queue.js';
import type {LlmAgent} from '../agents/llm_agent.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import type {RunConfig} from '../agents/run_config.js';
import {ScopedArtifactService} from '../artifacts/scoped_artifact_service.js';
import type {Event} from '../events/event.js';
import {getFunctionCalls} from '../events/event.js';
import type {LlmRequest} from '../models/llm_request.js';
import type {Runner} from '../runner/runner.js';
import {determineAgentForResumption} from '../runner/runner.js';
import type {Session} from '../sessions/session.js';
import type {BaseTool} from '../tools/base_tool.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {isWorkflow} from '../workflow/workflow.js';

/** Author of the events the user contributed to a session. */
const USER_AUTHOR = 'user';

/** WebSocket close code reported for a normal, successful closure. */
export const WEBSOCKET_NORMAL_CLOSURE_CODE = 1000;

/** How long {@link EvalLiveSession.close} waits for the consumer to finish. */
export const CONSUME_TIMEOUT_MS = 30_000;

/**
 * Calls that end the agent and hand off, instead of continuing the turn with a
 * tool response. Their `turnComplete` is real, so they must not arm the
 * tool-call guard in {@link EvalLiveSession.consumeNodeEvents}.
 */
const TURN_ENDING_FUNCTION_CALLS: ReadonlySet<string> = new Set([
  'finish_task',
  'transfer_to_agent',
  'task_completed',
]);

/**
 * Run config shared by every live driver of the eval system.
 *
 * Server-side voice-activity detection is off, so turn boundaries come from
 * the explicit activity markers the harness sends around each audio turn.
 *
 * adk-python also sets `StreamingMode.BIDI` here. adk-js rejects that value
 * (`createRunConfig` throws) because `Runner.runLive` *is* its bidirectional
 * path, so the field is omitted rather than translated.
 */
export const LIVE_RUN_CONFIG: RunConfig = {
  responseModalities: [Modality.AUDIO],
  outputAudioTranscription: {},
  inputAudioTranscription: {},
  realtimeInputConfig: {automaticActivityDetection: {disabled: true}},
};

/** Resolution of the timeout arm of the race in {@link EvalLiveSession.close}. */
const CONSUME_TIMED_OUT = Symbol('consume-timed-out');

/** Message logged when the consumer outlives {@link CONSUME_TIMEOUT_MS}. */
const CONSUME_TIMEOUT_WARNING = 'Timed out waiting for runLive to finish.';

/** Message of the error {@link EvalLiveSession.close} throws before `start`. */
const CLOSED_BEFORE_STARTED_ERROR =
  'The live session was closed before it was started.';

/**
 * Collects the events a live connection produces until the turn that asked for
 * them drains the queue.
 *
 * The live driver pushes events as they arrive, on its own schedule; the turn
 * generator takes whatever has arrived once the model reports the turn is
 * complete. This is the `asyncio.Queue` adk-python uses, in the form JS needs.
 */
export class LiveEventQueue {
  private events: Event[] = [];

  push(event: Event): void {
    this.events.push(event);
  }

  /** Returns every event queued so far and empties the queue. */
  drain(): Event[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }
}

/** The close-code fields a live transport error may carry. */
interface LiveClosureError {
  code?: unknown;
  status?: unknown;
  closeCode?: unknown;
}

function isObject(value: unknown): value is LiveClosureError {
  return typeof value === 'object' && value !== null;
}

/**
 * Reports whether an error is a normal Live WebSocket closure.
 *
 * The transports in play report the close code under different names, so all
 * three are checked. Matched structurally rather than with `instanceof`: a
 * second copy of `@google/genai` in the runtime raises a different class
 * object for the same failure.
 *
 * @param error The thrown value to classify.
 * @returns Whether the error reports close code 1000.
 */
export function isNormalLiveClosure(error: unknown): boolean {
  if (!isObject(error)) {
    return false;
  }
  return (
    error.code === WEBSOCKET_NORMAL_CLOSURE_CODE ||
    error.status === WEBSOCKET_NORMAL_CLOSURE_CODE ||
    error.closeCode === WEBSOCKET_NORMAL_CLOSURE_CODE
  );
}

/**
 * Rebuilds the request an agent's model was shown.
 *
 * The live flow builds it privately, so the request processors and the tools
 * are replayed here in the same order the flow applies them.
 *
 * @param agent The agent whose request to rebuild.
 * @param invocationContext The context the agent runs under.
 * @returns The request the agent would send.
 */
export async function recordLlmRequestForAgent(
  agent: LlmAgent,
  invocationContext: InvocationContext,
): Promise<LlmRequest> {
  const llmRequest: LlmRequest = {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };

  for (const processor of agent.requestProcessors) {
    for await (const _event of processor.runAsync(
      invocationContext,
      llmRequest,
    )) {
      // The processors are replayed for the request they build; the events
      // they emit belong to a real run and are dropped here.
    }
  }

  const toolContext = new Context({invocationContext});
  const tools = await agent.canonicalTools(
    new ReadonlyContext(invocationContext),
  );
  for (const tool of tools) {
    if (
      llmRequest.allowedTools &&
      !llmRequest.allowedTools.includes(tool.name)
    ) {
      continue;
    }
    await tool.processLlmRequest({toolContext, llmRequest});
  }

  return llmRequest;
}

/**
 * Records what one agent was shown, and returns the context to replay
 * `afterModelCallback` against.
 *
 * A live run fires neither model callback natively, but the eval plugins need
 * both: `beforeModelCallback` is what captures the instructions and tool
 * declarations an autorater grades against.
 *
 * @param agent The agent to record.
 * @param invocationContext The context the agent runs under.
 * @returns The callback context the agent's events replay against.
 */
async function recordAppDetailsForAgent(
  agent: LlmAgent,
  invocationContext: InvocationContext,
): Promise<Context> {
  const llmRequest = await recordLlmRequestForAgent(agent, invocationContext);
  const callbackContext = new Context({invocationContext});
  await invocationContext.pluginManager.runBeforeModelCallback({
    callbackContext,
    llmRequest,
  });
  return callbackContext;
}

/**
 * Drives one live conversation on behalf of the eval system.
 *
 * A live run is push-shaped: the model streams events whenever it likes, while
 * the eval loop is pull-shaped and asks for one turn at a time. This class
 * bridges the two. It owns the live request queue, consumes the event stream
 * on a background task, and releases a per-turn latch when the model reports
 * the turn is complete.
 *
 * Call {@link start} once, then {@link startTurn} and await
 * {@link turnComplete} per turn, then {@link close}.
 *
 * Intended for eval-system internal use. Do not depend on it directly.
 */
export class EvalLiveSession {
  /** The queue the live connection reads user turns and tool results from. */
  readonly liveRequestQueue = new LiveRequestQueue();

  /** The queue the background consumer pushes model events onto. */
  readonly eventQueue = new LiveEventQueue();

  /** The invocation every event of the current turn is stamped with. */
  currentInvocationId = newInvocationContextId();

  private readonly abortController = new AbortController();
  private consumeTask?: Promise<void>;
  private finished = false;
  private releaseTurn: () => void = () => {};
  private turnCompleteLatch: Promise<void>;

  constructor(
    private readonly runner: Runner,
    private readonly session: Session,
    private readonly userId: string,
    private readonly sessionId: string,
  ) {
    this.turnCompleteLatch = this.armTurnLatch();
  }

  /** Schedules the background consumer. A second call does nothing. */
  start(): void {
    if (this.consumeTask !== undefined) {
      return;
    }
    this.consumeTask = this.consumeEvents();
    // The task is only awaited in `close()`. Mark it handled now so a failure
    // before then is not reported as an unhandled rejection.
    this.consumeTask.catch(() => {});
  }

  /** Resolves when the model reports the current turn is complete. */
  get turnComplete(): Promise<void> {
    return this.turnCompleteLatch;
  }

  /** Whether the live stream has ended. */
  get isFinished(): boolean {
    return this.finished;
  }

  /** Stamps a new invocation id and re-arms the turn-complete latch. */
  startTurn(): void {
    this.currentInvocationId = newInvocationContextId();
    this.turnCompleteLatch = this.armTurnLatch();
  }

  /**
   * Consumes the live event stream until it ends.
   *
   * Public so a test can drive it directly, as adk-python's tests drive
   * `_consume_events`.
   */
  async consumeEvents(): Promise<void> {
    try {
      const root = this.runner.agent;
      // `RunnableRoot` is an agent or a workflow, so "not an agent" is the
      // workflow case, which `Runner.runLive` schedules.
      if (!isBaseAgent(root)) {
        return await this.consumeNodeEvents();
      }
      await this.consumeAgentEvents(root);
    } finally {
      this.finished = true;
      this.releaseTurn();
    }
  }

  /**
   * Drives a workflow root through `Runner.runLive`.
   *
   * Public so a test can drive it directly, as adk-python's tests drive
   * `_consume_node_events`.
   */
  async consumeNodeEvents(): Promise<void> {
    const callbackContextByAuthor = await this.recordNodeAppDetails();
    let inFunctionCallLoop = false;

    try {
      for await (const event of this.runner.runLive({
        userId: this.userId,
        sessionId: this.sessionId,
        liveRequestQueue: this.liveRequestQueue,
        runConfig: LIVE_RUN_CONFIG,
        abortSignal: this.abortController.signal,
      })) {
        event.invocationId = this.currentInvocationId;
        const callbackContext = callbackContextByAuthor.get(event.author ?? '');
        if (callbackContext !== undefined) {
          await this.runner.pluginManager.runAfterModelCallback({
            callbackContext,
            llmResponse: event,
          });
        }
        this.eventQueue.push(event);
        if (
          getFunctionCalls(event).some(
            (functionCall) =>
              !TURN_ENDING_FUNCTION_CALLS.has(functionCall.name ?? ''),
          )
        ) {
          inFunctionCallLoop = true;
        }
        inFunctionCallLoop = this.settleTurn(event, inFunctionCallLoop);
      }
    } catch (error: unknown) {
      if (!isNormalLiveClosure(error)) {
        throw error;
      }
      // A clean session close ends the stream; keep the transcript collected
      // so far instead of failing the eval case.
      logger.debug('Ignored WebSocket normal closure exception:', error);
    }
  }

  /**
   * Records the request each agent of a workflow graph was shown.
   *
   * A workflow serves several agents over one live stream, so each agent's
   * request is recorded up front and the events of that author replay
   * `afterModelCallback` against the context returned here. One agent failing
   * to record never aborts the run.
   *
   * Only top-level `graph.nodes` agents are recorded; agents nested in
   * sub-workflows are not.
   *
   * @returns The callback context of each recorded agent, keyed by agent name.
   */
  async recordNodeAppDetails(): Promise<Map<string, Context>> {
    const callbackContextByAuthor = new Map<string, Context>();
    const root = this.runner.agent;
    const graph = isWorkflow(root) ? root.graph : undefined;
    if (graph === undefined) {
      return callbackContextByAuthor;
    }

    for (const node of graph.nodes) {
      if (!isLlmAgent(node)) {
        continue;
      }
      try {
        callbackContextByAuthor.set(
          node.name,
          await recordAppDetailsForAgent(
            node,
            this.newLiveInvocationContext(node),
          ),
        );
      } catch (error: unknown) {
        logger.warn(
          `Failed to record app details for agent ${node.name}:`,
          error,
        );
      }
    }

    return callbackContextByAuthor;
  }

  /**
   * Closes the live request queue and waits for the consumer to finish.
   *
   * @throws {Error} If the session was never started, or the consumer failed
   *     with anything other than a normal WebSocket closure.
   */
  async close(): Promise<void> {
    this.liveRequestQueue.close();
    const consumeTask = this.consumeTask;
    if (consumeTask === undefined) {
      throw new Error(CLOSED_BEFORE_STARTED_ERROR);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<typeof CONSUME_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(CONSUME_TIMED_OUT), CONSUME_TIMEOUT_MS);
    });

    try {
      if ((await Promise.race([consumeTask, expiry])) === CONSUME_TIMED_OUT) {
        logger.warn(CONSUME_TIMEOUT_WARNING);
        this.abortController.abort();
      }
    } catch (error: unknown) {
      if (!isNormalLiveClosure(error)) {
        throw error;
      }
      logger.debug('Ignored WebSocket normal closure exception:', error);
    } finally {
      clearTimeout(timer);
    }
  }

  private armTurnLatch(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.releaseTurn = resolve;
    });
  }

  /**
   * Releases the turn latch on a real end of turn.
   *
   * A tool call is followed by its own `turnComplete`, which is not the end of
   * the turn; the guard swallows that one and the next one counts.
   *
   * @param event The event just consumed.
   * @param inFunctionCallLoop Whether a tool call is outstanding.
   * @returns Whether a tool call is still outstanding.
   */
  private settleTurn(event: Event, inFunctionCallLoop: boolean): boolean {
    if (!event.turnComplete || event.author === USER_AUTHOR) {
      return inFunctionCallLoop;
    }
    if (inFunctionCallLoop) {
      return false;
    }
    this.releaseTurn();
    return false;
  }

  /** Drives an agent root through its own live flow. */
  private async consumeAgentEvents(root: BaseAgent): Promise<void> {
    const agentToRun = determineAgentForResumption(
      this.session,
      root,
      this.runner.resumabilityConfig,
    );
    if (!isLlmAgent(agentToRun)) {
      throw new Error(
        `Cannot drive agent '${agentToRun.name}' via the LlmAgent live flow;` +
          ' an LlmAgent is required.',
      );
    }

    const invocationContext = this.newLiveInvocationContext(agentToRun);
    const callbackContext = await recordAppDetailsForAgent(
      agentToRun,
      invocationContext,
    );

    let inFunctionCallLoop = false;
    for await (const event of agentToRun.runLive(invocationContext)) {
      event.invocationId = this.currentInvocationId;
      await invocationContext.pluginManager.runAfterModelCallback({
        callbackContext,
        llmResponse: event,
      });
      this.eventQueue.push(event);
      if (!event.partial) {
        await this.runner.sessionService.appendEvent({
          session: this.session,
          event,
        });
      }
      const functionCalls = getFunctionCalls(event);
      if (functionCalls.length > 0) {
        inFunctionCallLoop = true;
        await this.runFunctionCalls(root, agentToRun, event, functionCalls);
      }
      inFunctionCallLoop = this.settleTurn(event, inFunctionCallLoop);
    }
  }

  /**
   * Runs the tools a live event asked for and feeds the results back.
   *
   * A tool that throws still gets an answer: the model is sent one error-
   * carrying `functionResponse` per call, so the turn continues instead of
   * stalling on a response that never arrives.
   */
  private async runFunctionCalls(
    root: BaseAgent,
    agent: LlmAgent,
    event: Event,
    functionCalls: FunctionCall[],
  ): Promise<void> {
    const invocationContext = this.newLiveInvocationContext(
      root,
      event.invocationId,
    );
    const rootAgent = this.runner.agent;
    const toolsDict: Record<string, BaseTool> = isLlmAgent(rootAgent)
      ? Object.fromEntries(
          (
            await rootAgent.canonicalTools(
              new ReadonlyContext(invocationContext),
            )
          ).map((tool) => [tool.name, tool]),
        )
      : {};

    try {
      const responseEvent = await handleFunctionCallsAsync({
        invocationContext,
        functionCallEvent: event,
        toolsDict,
        beforeToolCallbacks: agent.canonicalBeforeToolCallbacks,
        afterToolCallbacks: agent.canonicalAfterToolCallbacks,
      });
      for (const part of responseEvent?.content?.parts ?? []) {
        if (part.functionResponse) {
          this.liveRequestQueue.sendContent({role: 'tool', parts: [part]});
        }
      }
    } catch (error: unknown) {
      logger.error('Failed to handle function calls:', error);
      const message = formatError(error);
      for (const functionCall of functionCalls) {
        this.liveRequestQueue.sendContent({
          role: 'tool',
          parts: [
            {
              functionResponse: {
                name: functionCall.name,
                id: functionCall.id,
                response: {error: message},
              },
            },
          ],
        });
      }
    }
  }

  /** Builds the invocation context a live driver runs an agent under. */
  private newLiveInvocationContext(
    agent: BaseAgent,
    invocationId: string = newInvocationContextId(),
  ): InvocationContext {
    return new InvocationContext({
      invocationId,
      agent,
      session: this.session,
      sessionService: this.runner.sessionService,
      memoryService: this.runner.memoryService,
      credentialService: this.runner.credentialService,
      artifactService: this.runner.artifactService
        ? new ScopedArtifactService(this.runner.artifactService, {
            appName: this.runner.appName,
            userId: this.userId,
            sessionId: this.sessionId,
          })
        : undefined,
      pluginManager: this.runner.pluginManager,
      runConfig: LIVE_RUN_CONFIG,
      liveRequestQueue: this.liveRequestQueue,
      abortSignal: this.abortController.signal,
    });
  }
}
