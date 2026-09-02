/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall, Modality} from '@google/genai';

import {BaseAgent, isBaseAgent} from '../agents/base_agent.js';
import {Context} from '../agents/context.js';
import {handleFunctionCallsAsync} from '../agents/functions.js';
import {
  InvocationContext,
  newInvocationContextId,
} from '../agents/invocation_context.js';
import {LiveRequestQueue} from '../agents/live_request_queue.js';
import {isLlmAgent, LlmAgent} from '../agents/llm_agent.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {createRunConfig, RunConfig} from '../agents/run_config.js';
import {ScopedArtifactService} from '../artifacts/scoped_artifact_service.js';
import {InputValidationError} from '../errors/input_validation_error.js';
import {Event, getFunctionCalls} from '../events/event.js';
import {LlmRequest} from '../models/llm_request.js';
import {determineAgentForResumption, Runner} from '../runner/runner.js';
import {Session} from '../sessions/session.js';
import {BaseTool} from '../tools/base_tool.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';

/** Author of the events the user contributed to a session. */
export const USER_AUTHOR = 'user';

/** WebSocket close code reported for a normal, successful closure. */
export const WEBSOCKET_NORMAL_CLOSURE_CODE = 1000;

/** How long {@link EvalLiveSession.close} waits for the consumer to finish. */
export const CONSUME_TIMEOUT_MS = 30_000;

/**
 * Run config a live eval run drives the model under.
 *
 * Server-side voice-activity detection is off, so turn boundaries come from
 * the explicit activity markers the harness sends around each audio turn.
 *
 * adk-python also sets `StreamingMode.BIDI` here. adk-js rejects that value
 * (`createRunConfig` throws) because `runLive` *is* its bidirectional path, so
 * the field is omitted rather than translated.
 */
export const LIVE_RUN_CONFIG: RunConfig = {
  responseModalities: [Modality.AUDIO],
  outputAudioTranscription: {},
  inputAudioTranscription: {},
  realtimeInputConfig: {automaticActivityDetection: {disabled: true}},
};

/** Resolution of the timeout arm of the race in {@link EvalLiveSession.close}. */
const CONSUME_TIMED_OUT = Symbol('consume-timed-out');

/**
 * Rejects a root the live path cannot drive.
 *
 * `Runner.runLive` refuses a non-agent root, so a workflow would otherwise
 * fail deep inside the runner once the turn loop had already run.
 *
 * @param root The root the caller asked to evaluate.
 * @throws {InputValidationError} If the root is not an agent.
 */
export function assertLiveRootSupported(
  root: unknown,
): asserts root is BaseAgent {
  if (!isBaseAgent(root)) {
    throw new InputValidationError(
      'Live evaluation needs an agent root. `Runner.runLive` does not ' +
        'support a workflow root, so evaluate a workflow with ' +
        '`generateInferencesFromRootAgent` instead.',
    );
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
async function recordLlmRequestForAgent(
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

  /** The events the background consumer has collected for the current turn. */
  readonly eventQueue: Event[] = [];

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
   *
   * @throws {InputValidationError} If the runner's root is not an agent.
   */
  async consumeEvents(): Promise<void> {
    try {
      const root = this.runner.agent;
      assertLiveRootSupported(root);
      await this.consumeAgentEvents(root);
    } finally {
      this.finished = true;
      this.releaseTurn();
    }
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
      throw new Error('The live session was closed before it was started.');
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<typeof CONSUME_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(CONSUME_TIMED_OUT), CONSUME_TIMEOUT_MS);
    });

    try {
      if ((await Promise.race([consumeTask, expiry])) === CONSUME_TIMED_OUT) {
        logger.warn('Timed out waiting for the live run to finish.');
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
      // `close()` aborts a consumer that outlived its wait. Stop here so an
      // abandoned consumer stops writing to the session the caller has
      // already returned.
      if (this.abortController.signal.aborted) {
        return;
      }
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
        await this.runFunctionCalls(root, event, functionCalls);
      }
      inFunctionCallLoop = this.settleTurn(event, inFunctionCallLoop);
    }
  }

  /**
   * Runs the tools a live event asked for and feeds the results back.
   *
   * The tools and both tool callbacks come from the root agent, not from the
   * agent the live flow resolved, matching adk-python: its
   * `handle_function_calls_live` reads them off `invocation_context.agent`,
   * which the caller sets to the root.
   *
   * A tool that throws still gets an answer: the model is sent one error-
   * carrying `functionResponse` per call, so the turn continues instead of
   * stalling on a response that never arrives.
   */
  private async runFunctionCalls(
    root: BaseAgent,
    event: Event,
    functionCalls: FunctionCall[],
  ): Promise<void> {
    const invocationContext = this.newLiveInvocationContext(
      root,
      event.invocationId,
    );
    const toolsDict: Record<string, BaseTool> = isLlmAgent(root)
      ? Object.fromEntries(
          (
            await root.canonicalTools(new ReadonlyContext(invocationContext))
          ).map((tool) => [tool.name, tool]),
        )
      : {};

    try {
      const responseEvent = await handleFunctionCallsAsync({
        invocationContext,
        functionCallEvent: event,
        toolsDict,
        beforeToolCallbacks: isLlmAgent(root)
          ? root.canonicalBeforeToolCallbacks
          : [],
        afterToolCallbacks: isLlmAgent(root)
          ? root.canonicalAfterToolCallbacks
          : [],
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
        ? new ScopedArtifactService(
            this.runner.artifactService,
            this.runner.appName,
            this.userId,
            this.sessionId,
          )
        : undefined,
      pluginManager: this.runner.pluginManager,
      // Resolved rather than passed raw, so the run-wide `maxLlmCalls` cap is
      // populated. `Runner.runLive` does the same for the node path.
      runConfig: createRunConfig(LIVE_RUN_CONFIG),
      liveRequestQueue: this.liveRequestQueue,
      abortSignal: this.abortController.signal,
    });
  }
}
