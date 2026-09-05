/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {context, type Span, SpanStatusCode, trace} from '@opentelemetry/api';
import {InvocationContext} from '../agents/invocation_context.js';
import {createEvent, Event} from '../events/event.js';
import {carryDeltaStamp} from '../sessions/state_write_order.js';
import {traceNodeExecution, tracer} from '../telemetry/tracing.js';
import {formatError} from '../utils/error_utils.js';
import {BaseNode} from './base_node.js';
import {createSubBranch} from './branch_path.js';
import {
  InvocationAbortedError,
  isDynamicNodeFailError,
  isInvocationAbortedError,
  isNodeInterruptedError,
  isNodeReportedError,
  NodeReportedError,
  NodeTimeoutError,
} from './errors.js';
import {NodeContext} from './node_context.js';
import {
  claimNodeErrorReport,
  createNodeErrorEvent,
  isNodeErrorEvent,
} from './node_error_event.js';
import {createNodeState, NodeState} from './node_state.js';
import {NodeStatus} from './node_status.js';
import {getRetryDelaySeconds, shouldRetryNode} from './utils/retry_utils.js';

/**
 * Options controlling a single `ctx.runNode(...)` execution.
 */
export interface RunNodeOptions {
  /** Deterministic tracking name; defaults to `node.name`. */
  nodeName?: string;
  /**
   * Unique id for this specific run. Defaults to a per-node sequence — "1",
   * "2", "3" in call order — which is what a resume matches checkpoints on.
   *
   * Supply one only when position is not stable but identity is (a reorderable
   * collection: key it off the item's own id). Give it a non-numeric character
   * so it cannot collide with the automatic sequence: an all-digit id is
   * refused for any node ADK also numbers automatically in the same context,
   * whichever call comes first.
   */
  runId?: string;
  /** If true, the child's output replaces the caller's output. */
  useAsOutput?: boolean;
  /** If true, run the child in an isolated sub-branch. */
  useSubBranch?: boolean;
  /** Explicit branch, overriding the default/sub-branch computation. */
  overrideBranch?: string;
  /** Explicit isolation scope, overriding inheritance from the parent. */
  overrideIsolationScope?: string;
  /**
   * Explicit node path for the child (used by the dynamic scheduler to embed
   * the run id, e.g. `wf.node@1`, so distinct runs are distinguishable on
   * resume). Defaults to `${parent.nodePath}.${nodeName}`.
   */
  overrideNodePath?: string;
}

/** Parameters for {@link executeChildNode}. */
export interface ExecuteChildNodeParams {
  /** The context requesting the child run. */
  parent: NodeContext;
  /** The node to execute. */
  node: BaseNode;
  /** The input passed to the node. */
  input: unknown;
  /** Options controlling this run. */
  options?: RunNodeOptions;
  /**
   * Engine-supplied cancellation signal that overrides the parent invocation's
   * for this child (used by a Workflow to cancel in-flight siblings when a node
   * fails). Defaults to the parent invocation's abort signal.
   */
  abortSignal?: AbortSignal;
  nodeState?: NodeState;
  /**
   * Resume responses this run may consume, overriding the parent's. The
   * workflow loop passes an empty map for a run that is not the one recovered
   * from the previous turn, so a node re-triggered later in a resumed turn
   * starts clean instead of re-reading a response it already answered.
   */
  resumeInputs?: Record<string, unknown>;
  /**
   * Output from a previous run, carried forward on resume when the node had
   * both output and interrupts. An engine-level parameter, deliberately not on
   * {@link RunNodeOptions}: adk-python exposes the same capability on the
   * `NodeRunner` constructor and no production caller passes it.
   */
  priorOutput?: unknown;
  /** Unresolved interrupt ids from a previous run, carried forward on resume. */
  priorInterruptIds?: readonly string[];
}

/**
 * Executes a child node on behalf of `parent.runNode(...)`.
 *
 * Responsibilities (Phase 1 scope): create the child {@link NodeContext},
 * drive `node.run()`, enrich each emitted event (author, node path, branch,
 * isolation scope), track the child's `output`/`route`, apply the per-node
 * `timeout`, and retry on failure per `retryConfig`. Returns the child context.
 *
 * Retry semantics: each attempt starts with the child's per-attempt state
 * cleared (output, route, interrupt ids, and `actions.stateDelta`). Events are
 * the exception — they stream out through the shared channel as they are
 * produced and cannot be retracted, so a node that emits some events and then
 * fails will re-emit them when the attempt is retried. Nodes that must not
 * duplicate observable events across retries should emit only after their
 * fallible work has succeeded.
 */
export function executeChildNode(
  params: ExecuteChildNodeParams,
): Promise<NodeContext> {
  const {parent, node, options = {}} = params;
  const nodeName = options.nodeName ?? node.name;
  const nodePath =
    options.overrideNodePath ??
    (parent.nodePath ? `${parent.nodePath}.${nodeName}` : nodeName);

  // The span is started here, synchronously, rather than inside `runChildNode`:
  // its parent must be whatever span was active when the workflow SCHEDULED
  // this node. Nodes are raced concurrently in `Workflow.runLoop`, so a parent
  // captured any later would nest concurrent siblings inside whichever task
  // happened to resolve first.
  const span = tracer.startSpan(`execute_node ${nodeName}`);

  // Deliberately not `async`, and the callback is deliberately not `async`
  // either: `context.with` hands the inner promise straight back, so the child
  // settles on exactly the same microtask it did before tracing existed. Async
  // wrappers here would each add promise-adoption ticks, which is enough to
  // change how concurrently scheduled nodes interleave — an observability
  // change must not move execution around.
  return context.with(trace.setSpan(context.active(), span), () =>
    runChildNode({params, nodeName, nodePath, span}),
  );
}

interface RunChildNodeParams {
  params: ExecuteChildNodeParams;
  nodeName: string;
  nodePath: string;
  span: Span;
}

/** The body of {@link executeChildNode}, running under its `execute_node` span. */
async function runChildNode({
  params: {
    parent,
    node,
    input,
    options = {},
    abortSignal,
    nodeState: callerNodeState,
    resumeInputs,
    priorOutput,
    priorInterruptIds,
  },
  nodeName,
  nodePath,
  span,
}: RunChildNodeParams): Promise<NodeContext> {
  const runId = options.runId ?? nodeName;

  let branch = parent.branch;
  if (options.overrideBranch !== undefined) {
    branch = options.overrideBranch;
  } else if (options.useSubBranch) {
    branch = createSubBranch(parent.branch, {
      name: nodeName,
      runId: options.runId,
    });
  }

  const declaredScope =
    node.isolationScope === true ? `${nodePath}@${runId}` : node.isolationScope;
  const isolationScope =
    options.overrideIsolationScope ?? declaredScope ?? parent.isolationScope;

  // The child observes the engine-supplied abort signal when given (a Workflow
  // uses it to cancel siblings on failure), otherwise the parent invocation's.
  const effectiveAbortSignal =
    abortSignal ?? parent.invocationContext.abortSignal;

  const childIc =
    branch === parent.invocationContext.branch &&
    effectiveAbortSignal === parent.invocationContext.abortSignal &&
    isolationScope === parent.invocationContext.isolationScope
      ? parent.invocationContext
      : new InvocationContext({
          ...parent.invocationContext,
          branch,
          abortSignal: effectiveAbortSignal,
          isolationScope,
        });

  const child = new NodeContext({
    invocationContext: childIc,
    channel: parent.channel,
    nodePath,
    runId,
    resumeInputs: resumeInputs ?? parent.resumeInputs,
    isolationScope,
    // A node's own schema wins; otherwise it answers to its parent's.
    stateSchema: node.stateSchema ?? parent.stateSchema,
  });
  // Propagate the dynamic scheduler down; a nested Workflow overrides it.
  child.scheduler = parent.scheduler;
  // A parent that takes this child's output as its own is standing in for it,
  // so the child's output event answers for both — and for whatever the parent
  // was already standing in for.
  if (options.useAsOutput) {
    child.outputForAncestors = [
      parent.nodePath,
      ...parent.outputForAncestors,
    ].filter((path) => path !== '');
  }

  const nodeState =
    callerNodeState ??
    createNodeState({
      status: NodeStatus.RUNNING,
      input,
      runId,
    });

  const pluginManager = child.invocationContext.pluginManager;

  try {
    if (pluginManager?.hasPlugins) {
      const skipOutput = await pluginManager.runBeforeNodeCallback({
        node,
        nodeContext: child,
        input,
      });
      if (skipOutput !== undefined) {
        child.output = skipOutput;
        // A skipped node still fills its slot in the trace, so record it as
        // completed rather than leaving an attribute-less span behind.
        traceNodeExecution({
          nodePath,
          runId,
          attempt: nodeState.attemptCount,
          status: 'completed',
          interruptCount: child.interruptIds.length,
        });
        if (options.useAsOutput) {
          parent.output = child.output;
          parent.route = child.route;
        }
        return child;
      }
    }

    let succeeded = false;
    let inputRecorded = false;
    while (!succeeded) {
      resetState(child);
      // Inside the loop, because `resetState` clears exactly the fields prior
      // state populates: applying it once before the loop would drop it on the
      // second attempt. adk-python rebuilds the child context per attempt and
      // re-applies it there for the same reason.
      applyPriorState({child, priorOutput, priorInterruptIds});
      child.attemptCount = nodeState.attemptCount;
      try {
        inputRecorded = await runAttempt({
          node,
          child,
          input,
          nodeName,
          branch,
          isolationScope,
          nodePath,
          runId,
          attempt: nodeState.attemptCount,
        });
        failIfNodeReportedError(child, nodeName);
        succeeded = true;
      } catch (err) {
        // A dynamic child stopped to ask the user. Its ids are already on
        // `child`, so this node is waiting rather than failed.
        if (isNodeInterruptedError(err)) {
          succeeded = true;
          break;
        }
        // Cancellation is terminal: an aborted invocation (or a sibling
        // failure that cancelled this node) is never retried.
        if (isInvocationAbortedError(err)) {
          throw err;
        }
        // A dynamic child's own failure is not this node's to retry: rerunning
        // the body would re-run every sibling the child ran before it.
        if (isDynamicNodeFailError(err)) {
          throw err;
        }
        // Check retry eligibility with the attempt that just failed, compute
        // its backoff delay, THEN advance the counter (matches Python
        // semantics).
        const retryConfig = node.preparedRetryConfig;
        const willRetry = Boolean(
          retryConfig && shouldRetryNode({error: err, retryConfig, nodeState}),
        );
        emitNodeErrorEvent({
          child,
          error: err,
          nodeName,
          branch,
          isolationScope,
          attemptCount: nodeState.attemptCount,
          willRetry,
          abortSignal: effectiveAbortSignal,
        });
        if (!retryConfig || !willRetry) {
          throw err;
        }
        const delaySeconds = getRetryDelaySeconds({retryConfig, nodeState});
        nodeState.attemptCount += 1;
        await delay(delaySeconds * 1000, effectiveAbortSignal);
      }
    }

    if (!inputRecorded && child.interruptIds.length > 0) {
      recordInputForResume({child, nodeName, branch, isolationScope, input});
    }

    traceNodeExecution({
      nodePath,
      runId,
      attempt: nodeState.attemptCount,
      status: child.interruptIds.length > 0 ? 'waiting' : 'completed',
      interruptCount: child.interruptIds.length,
    });

    if (pluginManager?.hasPlugins) {
      const replacedOutput = await pluginManager.runAfterNodeCallback({
        node,
        nodeContext: child,
        output: child.output,
      });
      if (replacedOutput !== undefined) {
        child.output = replacedOutput;
      }
    }

    // After the plugin hook, which can replace the output, and before the
    // handover to the parent, so the flushed event carries the final value. A
    // node that stopped to ask the user is excluded: its checkpoint event is
    // already in the stream, and adk-python reaches the flush only on the
    // non-interrupt path.
    if (child.interruptIds.length === 0) {
      flushOutputAndDeltas({child, nodeName, branch, isolationScope});
    }

    if (options.useAsOutput) {
      parent.output = child.output;
      parent.route = child.route;
      parent.outputDelegated = true;
    }

    return child;
  } catch (err) {
    traceNodeExecution({
      nodePath,
      runId,
      attempt: nodeState.attemptCount,
      status: 'failed',
      interruptCount: child.interruptIds.length,
    });
    span.setStatus({code: SpanStatusCode.ERROR, message: formatError(err)});
    throw err;
  } finally {
    span.end();
  }
}

interface RunAttemptParams extends RunOnceParams {
  nodePath: string;
  runId: string;
  attempt: number;
}

/**
 * Not `async`: a node without a retry config must reach `runOnce` and settle on
 * exactly the microtask it would have without tracing (see `executeChildNode`).
 *
 * Resolves to whether the attempt recorded the node's input for resume (see
 * {@link runOnce}).
 */
function runAttempt(params: RunAttemptParams): Promise<boolean> {
  const {node, nodePath, runId, attempt} = params;
  if (!node.preparedRetryConfig) {
    return runOnce(params);
  }
  return tracer.startActiveSpan(
    `execute_node_attempt ${params.nodeName}`,
    async (span) => {
      try {
        const inputRecorded = await runOnce(params);
        traceNodeExecution({
          nodePath,
          runId,
          attempt,
          status:
            params.child.interruptIds.length > 0 ? 'waiting' : 'completed',
          interruptCount: params.child.interruptIds.length,
        });
        return inputRecorded;
      } catch (err) {
        traceNodeExecution({
          nodePath,
          runId,
          attempt,
          status: 'failed',
          interruptCount: params.child.interruptIds.length,
        });
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: formatError(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Turns a failure the node *reported* into one it *threw*, so the engine's
 * existing failure path handles it. Only when the node produced nothing: one
 * that reported an error and still returned a value recovered.
 *
 * Claims the error so `Workflow.reportNodeError` does not emit a second event
 * for a failure the node already reported.
 */
function failIfNodeReportedError(child: NodeContext, nodeName: string): void {
  const reported = child.reportedError;
  if (
    !reported ||
    child.output !== undefined ||
    child.route !== undefined ||
    child.interruptIds.length > 0
  ) {
    return;
  }
  const error = new NodeReportedError({nodeName, ...reported});
  claimNodeErrorReport(error, child.invocationId);
  throw error;
}

/**
 * Reset per-attempt state so a retry starts clean. This covers everything a
 * failed attempt can leave behind on the child context: its output/route,
 * interrupt ids, AND its state writes. A node that calls `ctx.state.set(...)`
 * and then throws would otherwise leave the failed attempt's writes in the
 * delta, to be committed alongside the successful attempt's. `NodeContext`
 * builds its `State` over this exact `stateDelta` object once (in its
 * constructor), so we clear the keys in place rather than reassigning it. The
 * same goes for its artifact deltas, its output flags and a requested agent
 * transfer — everything adk-python discards by building a fresh child context
 * per attempt.
 *
 * Note: events already pushed through the channel on a failed attempt are
 * downstream and cannot be retracted, so a node that emits N events and
 * then fails re-emits those N on retry (see the note on `executeChildNode`).
 *
 * @param childNodeContext Node context to reset
 */
function resetState(childNodeContext: NodeContext): void {
  childNodeContext.output = undefined;
  childNodeContext.route = undefined;
  childNodeContext.interruptIds = [];
  childNodeContext.reportedError = undefined;
  childNodeContext.outputEmitted = false;
  childNodeContext.outputDelegated = false;
  childNodeContext.actions.transferToAgent = undefined;
  for (const key of Object.keys(childNodeContext.actions.stateDelta)) {
    delete childNodeContext.actions.stateDelta[key];
  }
  for (const key of Object.keys(childNodeContext.actions.artifactDelta)) {
    delete childNodeContext.actions.artifactDelta[key];
  }
}

interface ApplyPriorStateParams {
  child: NodeContext;
  priorOutput: unknown;
  priorInterruptIds: readonly string[] | undefined;
}

/**
 * Restores the output and interrupt ids a previous turn left unresolved.
 *
 * The output is marked as already emitted: an event carried it last turn, so
 * {@link flushOutputAndDeltas} must not emit it a second time.
 */
function applyPriorState({
  child,
  priorOutput,
  priorInterruptIds,
}: ApplyPriorStateParams): void {
  if (priorOutput !== undefined) {
    child.output = priorOutput;
    child.outputEmitted = true;
  }
  for (const id of priorInterruptIds ?? []) {
    if (!child.interruptIds.includes(id)) {
      child.interruptIds.push(id);
    }
  }
}

/**
 * Whether an event carries something besides its output, and so must still
 * reach the stream once a delegating parent suppresses that output.
 *
 * Mirrors `_has_non_output_content` in `google/adk-python`
 * `workflow/_node_runner.py`.
 */
function hasNonOutputContent(event: Event): boolean {
  return (
    Object.keys(event.actions.stateDelta).length > 0 ||
    Object.keys(event.actions.artifactDelta).length > 0
  );
}

/**
 * Empties `from` onto `to` and returns the delta the event should carry,
 * bringing the state write-order stamps with each entry so a late commit can
 * still tell it has been superseded.
 *
 * A node can emit the context's own delta object — `createEventActions` keeps
 * whatever object it is handed — so the two can be the same. Then the entries
 * are copied out first, because emptying the context would otherwise empty the
 * event with it.
 */
function drainDelta<T>(
  from: Record<string, T>,
  to: Record<string, T>,
): Record<string, T> {
  const target = from === to ? {...from} : to;
  for (const key of Object.keys(from)) {
    target[key] = from[key];
    carryDeltaStamp(from, target, key);
    delete from[key];
  }
  return target;
}

/**
 * Moves the node's pending state and artifact deltas onto an outgoing event.
 *
 * Draining the context is what keeps a delta on exactly one event: without it
 * {@link flushOutputAndDeltas} would emit a trailing duplicate of every write a
 * node already reported.
 *
 * Mirrors `_flush_deltas` in `google/adk-python` `workflow/_node_runner.py`.
 */
function flushDeltas(event: Event, child: NodeContext): void {
  const {stateDelta, artifactDelta} = child.actions;
  if (
    Object.keys(stateDelta).length === 0 &&
    Object.keys(artifactDelta).length === 0
  ) {
    return;
  }
  event.actions.stateDelta = drainDelta(stateDelta, event.actions.stateDelta);
  event.actions.artifactDelta = drainDelta(
    artifactDelta,
    event.actions.artifactDelta,
  );
}

interface FlushOutputAndDeltasParams {
  child: NodeContext;
  nodeName: string;
  branch: string | undefined;
  isolationScope: string | undefined;
}

/**
 * Emits the node's deferred output, its unflushed route and any pending deltas
 * on one trailing event, once the node has finished.
 *
 * A node that assigns `ctx.output`, `ctx.route` or `ctx.state` after its last
 * yield has nothing left to carry those onto, so without this they never reach
 * the stream.
 *
 * Mirrors `_flush_output_and_deltas` in `google/adk-python`
 * `workflow/_node_runner.py`.
 */
function flushOutputAndDeltas({
  child,
  nodeName,
  branch,
  isolationScope,
}: FlushOutputAndDeltasParams): void {
  const hasDeferredOutput =
    child.output !== undefined &&
    !child.outputEmitted &&
    !child.outputDelegated;
  const hasUnflushedRoute = child.route !== undefined && !child.routeEmitted;
  const {stateDelta, artifactDelta} = child.actions;
  const hasDeltas =
    Object.keys(stateDelta).length > 0 || Object.keys(artifactDelta).length > 0;
  if (!hasDeferredOutput && !hasUnflushedRoute && !hasDeltas) {
    return;
  }

  const event = createEvent({
    author: nodeName,
    invocationId: child.invocationId,
    branch,
    output: hasDeferredOutput ? child.output : undefined,
    route: hasUnflushedRoute ? child.route : undefined,
  });
  flushDeltas(event, child);
  enrichEvent({event, child, nodeName, branch, isolationScope});
  child.channel.push(event);
  if (hasDeferredOutput) {
    child.outputEmitted = true;
  }
  if (hasUnflushedRoute) {
    child.routeEmitted = true;
  }
}

interface EmitNodeErrorEventParams {
  child: NodeContext;
  error: unknown;
  nodeName: string;
  branch: string | undefined;
  isolationScope: string | undefined;
  attemptCount: number;
  /** Whether the runner is about to retry the attempt that just failed. */
  willRetry: boolean;
  /** The signal that cancels this node, when it has one. */
  abortSignal: AbortSignal | undefined;
}

/**
 * Records one failed attempt as an error event, so a node that fails leaves a
 * record wherever it runs — under a `Workflow` or not — and a node that fails
 * three times leaves three.
 *
 * A retried attempt always emits: its error never reaches
 * `Workflow.reportNodeError`, and claiming it here would suppress the terminal
 * event when the node rethrows the same object. A terminal attempt emits only
 * when it claims the error first, so the workflow does not report it twice.
 */
function emitNodeErrorEvent({
  child,
  error,
  nodeName,
  branch,
  isolationScope,
  attemptCount,
  willRetry,
  abortSignal,
}: EmitNodeErrorEventParams): void {
  // Cancellation is not failure. A node cut short by an abort — the invocation
  // itself, or a sibling's failure — throws whatever its body throws on the way
  // out, and that is not a record worth keeping. Same guard as
  // `Workflow.reportNodeError`.
  if (abortSignal?.aborted) {
    return;
  }
  // The node reported this failure itself, so its own error event is already in
  // the stream and `failIfNodeReportedError` claimed it on the node's behalf.
  if (isNodeReportedError(error)) {
    return;
  }
  if (!willRetry && !claimNodeErrorReport(error, child.invocationId)) {
    return;
  }
  child.channel.push(
    createNodeErrorEvent({
      error,
      attemptCount,
      author: nodeName,
      invocationId: child.invocationId,
      nodeInfo: {path: child.nodePath},
      branch,
      isolationScope,
    }),
  );
}

interface RunOnceParams {
  node: BaseNode;
  child: NodeContext;
  input: unknown;
  nodeName: string;
  branch: string | undefined;
  isolationScope: string | undefined;
}

/**
 * Drives one attempt of `node.run()`, enriching and pushing each event and
 * tracking the child's output/route.
 *
 * When the node declares a `timeout` OR an external abort signal is present
 * (the invocation's, or the workflow-scoped one used to cancel siblings when
 * another node fails), execution is driven step-by-step and raced against those
 * conditions: a fired deadline raises {@link NodeTimeoutError}; any other abort
 * raises {@link InvocationAbortedError}. Either way the engine stops consuming
 * events (so nothing is pushed past cancellation — which would otherwise leak
 * into a retry or the next node), closes the generator so its `finally` blocks
 * run, and aborts `child.abortSignal` so a cooperative node body can cancel its
 * own in-flight work. Mirrors the cancellation semantics of Python's
 * `asyncio.wait_for`.
 *
 * When there is neither a deadline nor an abort signal, a plain `for await`
 * fast path is used.
 *
 * Resolves to whether an event the node emitted carried interrupt ids, and so
 * got its input stamped on it for resume.
 */
async function runOnce({
  node,
  child,
  input,
  nodeName,
  branch,
  isolationScope,
}: RunOnceParams): Promise<boolean> {
  let inputRecorded = false;
  const consume = (event: Event): void => {
    // Read before `enrichEvent`, which fills an absent author in with the
    // node's own name — after it, every event would look native.
    const isNativeNodeEvent = !event.author || event.author === nodeName;
    enrichEvent({event, child, nodeName, branch, isolationScope});
    // An event can carry a state delta that never went through `ctx.state`,
    // so the schema is enforced here too rather than only on the setter.
    const emittedDelta = event.actions?.stateDelta;
    if (emittedDelta && emittedDelta !== child.actions.stateDelta) {
      child.state.validateDelta(emittedDelta);
    }
    if (event.output !== undefined) {
      child.output = event.output;
      if (child.outputDelegated) {
        if (!hasNonOutputContent(event)) {
          return;
        }
        event.output = undefined;
        event.content = undefined;
      }
    } else if (event.nodeInfo?.messageAsOutput) {
      child.output = event.content;
    }
    // Only a node's own event carries its decisions. Without this a structured
    // parent (a SequentialAgent, say) would adopt a nested sub-agent's route
    // and agent transfer as its own.
    if (isNativeNodeEvent) {
      if (event.route !== undefined) {
        child.route = event.route;
        // After the assignment: the setter re-arms the flush.
        child.routeEmitted = true;
      }
      if (event.actions?.transferToAgent !== undefined) {
        child.actions.transferToAgent = event.actions.transferToAgent;
      }
    }
    if (event.errorCode !== undefined && !isNodeErrorEvent(event)) {
      child.reportedError = {
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
      };
    }
    // HITL: an interrupt event marks its ids as long-running tool ids.
    if (event.longRunningToolIds && event.longRunningToolIds.length > 0) {
      for (const id of event.longRunningToolIds) {
        if (!child.interruptIds.includes(id)) {
          child.interruptIds.push(id);
        }
      }
      // Persist the node's input on the interrupt event so a resumed
      // (waiting) node re-runs with its ORIGINAL input, not the resume
      // message. Rehydrated by reconstructNodeStates on the next turn.
      event.actions.agentState = {
        ...(event.actions.agentState ?? {}),
        input,
      };
      inputRecorded = true;
    }
    // A partial event is one slice of a streamed message; the deltas belong on
    // the finished one, so they wait for the next non-partial event.
    if (!event.partial) {
      flushDeltas(event, child);
    }
    child.channel.push(event);
    if (event.output !== undefined) {
      child.outputEmitted = true;
    }
    // After the push, so the FIRST such event reaches the stream and only the
    // ones after it are suppressed as duplicates of the node's answer.
    if (event.nodeInfo?.messageAsOutput) {
      child.outputDelegated = true;
    }
  };

  const parentSignal = child.invocationContext.abortSignal;
  const hasTimeout = typeof node.timeout === 'number' && node.timeout > 0;

  // Fast path: no per-node deadline and no external cancellation to observe.
  if (!hasTimeout && !parentSignal) {
    for await (const event of node.run(child, input)) {
      consume(event);
    }
    return inputRecorded;
  }

  // Cooperative cancellation (external abort, no deadline): expose the abort
  // signal as `ctx.abortSignal` so a cooperative node can wind down its own work
  // (e.g. a Workflow child stopping when a sibling fails), then drain normally.
  // We do NOT force-stop: a node that ignores the signal runs to completion
  // (best-effort), and a node that fails still surfaces its error — with the
  // retry backoff observing the same signal.
  if (!hasTimeout) {
    child.abortSignal = parentSignal;
    try {
      for await (const event of node.run(child, input)) {
        consume(event);
      }
    } finally {
      child.abortSignal = undefined;
    }
    return inputRecorded;
  }

  // Deadline path: drive the node step-by-step and race each step against the
  // timeout (and any external abort). On the deadline (or abort) the engine
  // stops consuming events, closes the generator so its `finally` runs, and
  // aborts `child.abortSignal` so a cooperative body can cancel its in-flight
  // work; the run rejects with NodeTimeoutError for a fired deadline and
  // InvocationAbortedError for any other abort. Mirrors Python's
  // `asyncio.wait_for`.
  const timeoutSeconds = node.timeout;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, {once: true});
  }
  let deadlineFired = false;
  const timer = setTimeout(
    () => {
      deadlineFired = true;
      controller.abort();
    },
    (timeoutSeconds ?? 0) * 1000,
  );
  child.abortSignal = controller.signal;

  // A single promise that rejects once the deadline (or external abort) fires;
  // reused across iterations so we don't leak a listener per step.
  const aborted = new Promise<never>((_, reject) => {
    const fail = () =>
      reject(
        deadlineFired
          ? new NodeTimeoutError({nodeName, timeout: timeoutSeconds ?? 0})
          : new InvocationAbortedError(
              `Invocation aborted while running node '${nodeName}'.`,
            ),
      );
    if (controller.signal.aborted) {
      fail();
    } else {
      controller.signal.addEventListener('abort', fail, {once: true});
    }
  });

  const iterator = node.run(child, input)[Symbol.asyncIterator]();
  try {
    let result = await Promise.race([iterator.next(), aborted]);
    while (!result.done) {
      consume(result.value);
      result = await Promise.race([iterator.next(), aborted]);
    }
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
    child.abortSignal = undefined;
    // Best-effort: close the generator so its `finally`/cleanup runs. This is
    // queued behind any in-flight `next()`; its result is discarded.
    void Promise.resolve(iterator.return?.(undefined)).catch(() => {});
  }
  return inputRecorded;
}

interface RecordInputForResumeParams {
  child: NodeContext;
  nodeName: string;
  branch: string | undefined;
  isolationScope: string | undefined;
  input: unknown;
}

/**
 * Writes the resume checkpoint for a waiting node that has no event of its own
 * to carry its input — one waiting on a `ctx.runNode` child rather than on an
 * interrupt it raised.
 *
 * Carries no content and no output, so it renders nowhere; it exists to be read
 * back by {@link reconstructNodeRuns}.
 */
function recordInputForResume({
  child,
  nodeName,
  branch,
  isolationScope,
  input,
}: RecordInputForResumeParams): void {
  const event = createEvent({
    author: nodeName,
    invocationId: child.invocationId,
    branch,
    longRunningToolIds: [...child.interruptIds],
    actions: {agentState: {input}},
  });
  enrichEvent({event, child, nodeName, branch, isolationScope});
  child.channel.push(event);
}

interface EnrichEventParams {
  event: Event;
  child: NodeContext;
  nodeName: string;
  branch: string | undefined;
  isolationScope: string | undefined;
}

/**
 * Stamps engine-owned provenance onto an event.
 *
 * `author`, `branch` and `isolationScope` are only filled in when the node left
 * them unset, so a node can override them. `path` is different: it is
 * engine-owned and always set to the child's real node path — a node must not be
 * able to misreport where it ran.
 */
function enrichEvent({
  event,
  child,
  nodeName,
  branch,
  isolationScope,
}: EnrichEventParams): void {
  if (!event.author) {
    event.author = nodeName;
  }
  if (!event.invocationId) {
    event.invocationId = child.invocationId;
  }
  // Engine-owned: always stamp the true node path (see doc above).
  event.nodeInfo = {...(event.nodeInfo ?? {}), path: child.nodePath};
  if (event.output !== undefined) {
    event.nodeInfo.outputFor = [child.nodePath, ...child.outputForAncestors];
  }
  if (branch !== undefined && event.branch === undefined) {
    event.branch = branch;
  }
  if (isolationScope !== undefined && event.isolationScope === undefined) {
    event.isolationScope = isolationScope;
  }
}

/**
 * Promise-based delay that rejects early (with {@link InvocationAbortedError})
 * if the abort signal fires — so an abort during retry backoff is
 * distinguishable from a node failure.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new InvocationAbortedError('Invocation aborted during retry.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new InvocationAbortedError('Invocation aborted during retry.'));
    };
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}
