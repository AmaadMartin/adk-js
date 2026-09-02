/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Modality} from '@google/genai';

import {Context} from '../agents/context.js';
import {
  TASK_COMPLETED_FUNCTION_CALL_NAME,
  TRANSFER_TO_AGENT_FUNCTION_CALL_NAME,
} from '../agents/framework_function_calls.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {LiveRequestQueue} from '../agents/live_request_queue.js';
import {isLlmAgent, LlmAgent} from '../agents/llm_agent.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {RunConfig, StreamingMode} from '../agents/run_config.js';
import {ScopedArtifactService} from '../artifacts/scoped_artifact_service.js';
import {InputValidationError} from '../errors/input_validation_error.js';
import {createNewEventId, Event} from '../events/event.js';
import {
  finalizeDynamicInstructions,
  LlmRequest,
} from '../models/llm_request.js';
import {getFunctionCalls} from '../models/llm_response.js';
import {Runner} from '../runner/runner.js';
import {Session} from '../sessions/session.js';
import {FINISH_TASK_TOOL_NAME} from '../tools/finish_task_tool.js';
import {asRecord} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {
  runNodeAsInvocation,
  type RunnableRoot,
} from '../workflow/run_node_as_invocation.js';
import {isWorkflow, Workflow} from '../workflow/workflow.js';

/** Author of the events the user contributed to a session. */
const USER_AUTHOR = 'user';

/**
 * Function calls that end the agent and hand off, rather than opening a tool
 * round the agent still owes an answer to.
 *
 * The `turnComplete` that follows one of these is a real end of turn, so the
 * node driver must not treat the call as a reason to keep the turn open.
 */
const TURN_ENDING_FUNCTION_CALLS: ReadonlySet<string> = new Set([
  FINISH_TASK_TOOL_NAME,
  TRANSFER_TO_AGENT_FUNCTION_CALL_NAME,
  TASK_COMPLETED_FUNCTION_CALL_NAME,
]);

/**
 * Whether an event opens a tool round the agent still owes an answer to.
 *
 * An event carrying only turn-ending calls does not: the agent handed off, so
 * the `turnComplete` after it ends the turn. One ordinary call is enough to
 * open the round, even alongside a turn-ending one.
 *
 * @param event The event the driver just received.
 * @returns Whether the turn must survive the next `turnComplete`.
 */
export function opensToolRound(event: Event): boolean {
  return getFunctionCalls(event).some(
    (call) => !TURN_ENDING_FUNCTION_CALLS.has(call.name ?? ''),
  );
}

/** WebSocket close code the Live API reports for a normal closure. */
const WEBSOCKET_NORMAL_CLOSURE_CODE = 1000;

/** Seconds {@link EvalLiveSession.close} waits for the driver to stop. */
export const LIVE_SHUTDOWN_TIMEOUT_SECONDS = 30;

const MILLIS_PER_SECOND = 1000;

/**
 * Run config shared by every live eval driver.
 *
 * Server-side voice-activity detection is off, so turn boundaries come from
 * the activity markers the driver puts around the audio it sends rather than
 * from the model's own guess at when the user stopped talking.
 *
 * One object is shared by every eval run, so it is frozen against a direct
 * write and each session runs against a deep copy. A shallow copy would still
 * alias `realtimeInputConfig`, which `Object.freeze` does not reach.
 */
export const LIVE_RUN_CONFIG: RunConfig = Object.freeze({
  streamingMode: StreamingMode.BIDI,
  responseModalities: [Modality.AUDIO],
  outputAudioTranscription: {},
  inputAudioTranscription: {},
  realtimeInputConfig: {automaticActivityDetection: {disabled: true}},
});

/**
 * Reports whether an error is the Live API's normal (1000) WebSocket closure.
 *
 * Matched structurally rather than by class, for the reason
 * `vertex_ai_session_service.ts` gives: a bundled `@google/genai` resolves its
 * own copy of the SDK, so its error classes are not identical across copies
 * and `instanceof` misses them. A gRPC transport reports the close code as
 * `code`, the `@google/genai` client as `status`.
 *
 * @param error The value a live run threw.
 * @returns Whether the run ended in a normal closure.
 */
export function isNormalClosure(error: unknown): boolean {
  const record = asRecord(error);
  return (
    record?.code === WEBSOCKET_NORMAL_CLOSURE_CODE ||
    record?.status === WEBSOCKET_NORMAL_CLOSURE_CODE
  );
}

/**
 * Returns the root as one of the two shapes a live eval run can drive.
 *
 * An `LlmAgent` runs through its own live flow. A `Workflow` runs as a node,
 * which drives the agents in its graph over the same connection. Any other
 * `BaseAgent` — a `SequentialAgent`, a custom agent — has no live path in
 * adk-js and is refused.
 *
 * @param root The root under evaluation.
 * @returns The same root, narrowed to the shape that names its driver.
 * @throws {InputValidationError} If the root is neither an `LlmAgent` nor a
 *     `Workflow`.
 */
export function requireLiveEvalRoot(root: RunnableRoot): LlmAgent | Workflow {
  if (isLlmAgent(root) || isWorkflow(root)) {
    return root;
  }
  throw new InputValidationError(
    `Live evaluation requires an LlmAgent or a Workflow root; '${root.name}' ` +
      'cannot be driven live.',
  );
}

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

/** A promise for one turn, and the call that completes it. */
interface TurnSignal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function newTurnSignal(): TurnSignal {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {promise, resolve: settle};
}

/**
 * Owns the live connection of one eval conversation.
 *
 * The conversation is driven from two sides at once: the eval loop pushes user
 * turns into {@link liveRequestQueue} and waits for {@link turnComplete}, while
 * a background driver pulls the model's events out of the agent's live flow.
 * This class owns that driver, the connection it runs on, and the shutdown
 * that releases both. It is the runtime counterpart of `Session`, which holds
 * the conversation's data.
 *
 * The live flow does not fire the model callbacks that plugins rely on, so the
 * driver fires them itself: `beforeModelCallback` once with the request the
 * agent would have sent, and `afterModelCallback` once per event. Without them
 * an autorater has no record of the instructions and tools the agent was
 * shown.
 *
 * Intended for eval-system internal use. Do not depend on it directly.
 */
export class EvalLiveSession {
  readonly liveRequestQueue = new LiveRequestQueue();
  readonly eventQueue = new LiveEventQueue();

  private readonly root: LlmAgent | Workflow;
  private readonly abortController = new AbortController();
  private consumePromise?: Promise<void>;
  private invocationId = createNewEventId();
  private turnSignal = newTurnSignal();
  private finished = false;

  /**
   * @param runner The runner whose services and plugins the run uses.
   * @param session The session the conversation is recorded in.
   * @throws {InputValidationError} If the runner's root is neither an
   *     `LlmAgent` nor a `Workflow`. The root is classified here, so an
   *     unsupported one is refused before anything is started.
   */
  constructor(
    private readonly runner: Runner,
    private readonly session: Session,
  ) {
    this.root = requireLiveEvalRoot(runner.agent);
  }

  /** Id every event of the turn in flight is stamped with. */
  get currentInvocationId(): string {
    return this.invocationId;
  }

  /** Resolves when the model reports the turn in flight is complete. */
  get turnComplete(): Promise<void> {
    return this.turnSignal.promise;
  }

  /** Whether the background driver has stopped. */
  get isFinished(): boolean {
    return this.finished;
  }

  /**
   * Starts the background driver.
   *
   * @throws {Error} If the session was already started.
   */
  start(): void {
    if (this.consumePromise !== undefined) {
      throw new Error('Live session was already started.');
    }
    const consumePromise = this.consumeEvents();
    // Nothing awaits the driver until `close`, and a turn can take as long as
    // the user simulator does. A driver that fails in that window would be an
    // unhandled rejection, which terminates the process; marking it handled
    // here parks the failure until `close` reports it.
    consumePromise.catch(() => {});
    this.consumePromise = consumePromise;
  }

  /** Opens a new turn: a fresh invocation id and a fresh turn promise. */
  startTurn(): void {
    this.invocationId = createNewEventId();
    this.turnSignal = newTurnSignal();
    // A driver that has already stopped will never resolve the new signal, so
    // the turn would wait out its whole timeout instead of ending at once.
    if (this.finished) {
      this.turnSignal.resolve();
    }
  }

  /**
   * Closes the connection and waits for the background driver to stop.
   *
   * A driver still running after {@link LIVE_SHUTDOWN_TIMEOUT_SECONDS} is
   * aborted and abandoned, so a stuck model cannot hang the eval run.
   *
   * @throws {Error} If the session was never started, or if the driver failed
   *     with anything other than a normal closure.
   */
  async close(): Promise<void> {
    this.liveRequestQueue.close();
    const consumePromise = this.consumePromise;
    if (consumePromise === undefined) {
      throw new Error('Live session was exited before it was started.');
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<'timed-out'>((resolve) => {
      timer = setTimeout(
        () => resolve('timed-out'),
        LIVE_SHUTDOWN_TIMEOUT_SECONDS * MILLIS_PER_SECOND,
      );
    });

    try {
      const outcome = await Promise.race([
        consumePromise.then(() => 'stopped' as const),
        expiry,
      ]);
      if (outcome === 'timed-out') {
        logger.warn('Timed out waiting for the live run to finish.');
        this.abortController.abort();
      }
    } catch (error: unknown) {
      if (!isNormalClosure(error)) {
        throw error;
      }
      logger.debug('Ignored WebSocket normal closure:', error);
    } finally {
      clearTimeout(timer);
    }
  }

  private async consumeEvents(): Promise<void> {
    try {
      if (isWorkflow(this.root)) {
        await this.consumeNodeEvents(this.root);
      } else {
        await this.consumeAgentEvents(this.root);
      }
    } finally {
      this.finished = true;
      // Release a turn that is still waiting, so it ends with the transcript
      // collected so far instead of running out its own timeout.
      this.turnSignal.resolve();
    }
  }

  /** Drives an `LlmAgent` root through its own live flow. */
  private async consumeAgentEvents(agent: LlmAgent): Promise<void> {
    const invocationContext = this.newLiveInvocationContext(agent);
    const callbackContext = await this.recordAppDetails(
      agent,
      invocationContext,
    );

    return this.consumeLiveEvents(
      agent.runLive(invocationContext),
      () => callbackContext,
      // The agent's live flow runs the tools itself and sends their results
      // straight back over the connection, so the driver only has to notice
      // that a tool round is open. adk-python's driver runs them a second
      // time; adk-js does not, because that would call every tool twice.
      (event) => getFunctionCalls(event).length > 0,
    );
  }

  /**
   * Drives a `Workflow` root as a node, over the same live connection.
   *
   * A workflow serves several agents on one stream, so each agent's request is
   * recorded up front and `afterModelCallback` fires with the context of the
   * agent that authored the event.
   *
   * adk-python drives this through `Runner.run_live`, which appends each event
   * on the way through. adk-js's `Runner.runLive` refuses a workflow root, so
   * this driver runs the node itself and therefore appends the events too. The
   * session ends up holding the same events either way.
   *
   * A normal WebSocket closure ends the stream rather than failing the eval
   * case. {@link close} applies that policy for both drivers, so it is not
   * repeated here.
   */
  private async consumeNodeEvents(workflow: Workflow): Promise<void> {
    const invocationContext = this.newLiveInvocationContext(undefined);
    const contextByAuthor = await this.recordNodeAppDetails(
      workflow,
      invocationContext,
    );

    return this.consumeLiveEvents(
      runNodeAsInvocation(workflow, invocationContext),
      (event) => contextByAuthor.get(event.author),
      opensToolRound,
    );
  }

  /**
   * Reads one driver's events until its stream ends.
   *
   * @param events The driver's event stream.
   * @param contextFor The callback context recorded for an event's author, or
   *     `undefined` when nothing was recorded for it.
   * @param opensRound Whether an event opens a tool round the agent still owes
   *     an answer to. The two drivers disagree: the agent flow keeps the turn
   *     open for any call, while a workflow's handoff calls end the agent.
   */
  private async consumeLiveEvents(
    events: AsyncIterable<Event>,
    contextFor: (event: Event) => Context | undefined,
    opensRound: (event: Event) => boolean,
  ): Promise<void> {
    let inFunctionCallLoop = false;
    for await (const event of events) {
      event.invocationId = this.invocationId;
      const callbackContext = contextFor(event);
      if (callbackContext !== undefined) {
        await this.runner.pluginManager.runAfterModelCallback({
          callbackContext,
          llmResponse: event,
        });
      }
      this.eventQueue.push(event);
      if (!event.partial) {
        await this.runner.sessionService.appendEvent({
          session: this.session,
          event,
        });
      }

      if (opensRound(event)) {
        inFunctionCallLoop = true;
      }

      if (event.turnComplete && event.author !== USER_AUTHOR) {
        // A `turnComplete` that closes a tool-call round is not the end of
        // the turn: the model still has to answer with the tool's result.
        if (inFunctionCallLoop) {
          inFunctionCallLoop = false;
        } else {
          this.turnSignal.resolve();
        }
      }
    }
  }

  /**
   * Builds the invocation context one live driver runs under.
   *
   * @param agent The agent the context runs, or `undefined` for a workflow
   *     root: a workflow is a node, not an agent, so no agent is in play at
   *     that level.
   */
  private newLiveInvocationContext(
    agent: LlmAgent | undefined,
  ): InvocationContext {
    const {runner, session} = this;
    return new InvocationContext({
      artifactService: runner.artifactService
        ? new ScopedArtifactService(
            runner.artifactService,
            runner.appName,
            session.userId,
            session.id,
          )
        : undefined,
      sessionService: runner.sessionService,
      memoryService: runner.memoryService,
      credentialService: runner.credentialService,
      // The connection outlives every turn, so it gets an id of its own. Each
      // event is then re-stamped with the id of the turn that was in flight
      // when it arrived, which is what groups the transcript into invocations.
      invocationId: createNewEventId(),
      agent,
      session,
      // A deep copy, so a processor that edits the run config — including a
      // nested field a shallow copy would still share — cannot edit the config
      // the next eval run starts from.
      runConfig: structuredClone(LIVE_RUN_CONFIG),
      pluginManager: runner.pluginManager,
      liveRequestQueue: this.liveRequestQueue,
      abortSignal: this.abortController.signal,
      resumabilityConfig: runner.resumabilityConfig,
    });
  }

  /**
   * Fires `beforeModelCallback` with the request the agent would have sent.
   *
   * `LlmAgent` builds that request privately on the live path, so it is rebuilt
   * here from the agent's public request processors and tools.
   *
   * @param agent The agent whose request is recorded. It is the agent
   *     `invocationContext` runs, passed explicitly because the context types
   *     its own agent as a plain `BaseAgent`.
   * @param invocationContext The context the request is built under.
   * @returns The callback context, which the driver reuses for every
   *     `afterModelCallback`.
   */
  private async recordAppDetails(
    agent: LlmAgent,
    invocationContext: InvocationContext,
  ): Promise<Context> {
    const llmRequest = await buildLiveLlmRequest(agent, invocationContext);
    const callbackContext = new Context({invocationContext});
    await this.runner.pluginManager.runBeforeModelCallback({
      callbackContext,
      llmRequest,
    });
    return callbackContext;
  }

  /**
   * Records one live request per agent in the workflow's graph, keyed by the
   * agent's name — which is the author of the events it produces.
   *
   * Only the top-level `graph.nodes` agents are recorded. An agent nested in a
   * sub-workflow or behind a wrapper node is not, so its events fire no
   * `afterModelCallback`, matching adk-python.
   *
   * A workflow driven by a `dynamicEntry` has no graph and records nothing. A
   * failure on one agent is logged and skipped, so it never aborts the run.
   *
   * @param workflow The workflow root under evaluation.
   * @param baseContext The context the graph runs under. Each agent's request
   *     is recorded under a copy of it, so a recorded request belongs to the
   *     same invocation as the events it explains.
   * @returns The callback context for each recorded agent, keyed by the
   *     agent's name. The key type admits `undefined` because that is what an
   *     event's author is typed as, and an authorless event matches nothing.
   */
  private async recordNodeAppDetails(
    workflow: Workflow,
    baseContext: InvocationContext,
  ): Promise<Map<string | undefined, Context>> {
    const contextByAuthor = new Map<string | undefined, Context>();
    const graph = workflow.graph;
    if (graph === undefined) {
      return contextByAuthor;
    }

    for (const node of graph.nodes) {
      if (!isLlmAgent(node)) {
        continue;
      }
      try {
        const invocationContext = baseContext.clone({agent: node});
        contextByAuthor.set(
          node.name,
          await this.recordAppDetails(node, invocationContext),
        );
      } catch (error: unknown) {
        logger.warn(
          `Failed to record app details for agent ${node.name}.`,
          error,
        );
      }
    }
    return contextByAuthor;
  }
}

/**
 * Rebuilds the request an agent's live flow would send to the model.
 *
 * Runs the same public request processors and tool preprocessing the flow runs,
 * so the recorded instructions and tool declarations are the ones the model
 * actually saw.
 */
async function buildLiveLlmRequest(
  agent: LlmAgent,
  invocationContext: InvocationContext,
): Promise<LlmRequest> {
  const llmRequest: LlmRequest = {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
  };

  for (const processor of agent.requestProcessors) {
    for await (const event of processor.runAsync(
      invocationContext,
      llmRequest,
    )) {
      logger.debug(`Discarded preprocessing event ${event.id}.`);
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
  finalizeDynamicInstructions(llmRequest);

  return llmRequest;
}
