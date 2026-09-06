/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {context, type Span, SpanStatusCode, trace} from '@opentelemetry/api';
import {InvocationContext} from '../agents/invocation_context.js';
import {createEvent, Event} from '../events/event.js';
import {mergeEventActions} from '../events/event_actions.js';
import {traceNodeExecution, tracer} from '../telemetry/tracing.js';
import {formatError} from '../utils/error_utils.js';
import {BaseNode} from './base_node.js';
import {createSubBranch} from './branch_path.js';
import {
  InvocationAbortedError,
  isDynamicNodeFailError,
  isInvocationAbortedError,
  isNodeInterruptedError,
  NodeReportedError,
  NodeTimeoutError,
} from './errors.js';
import {NodeContext} from './node_context.js';
import {
  claimNodeErrorReport,
  createNodeErrorEvent,
  isNodeErrorEvent,
  isNodeErrorReported,
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
  /**
   * Cancellation signal for this child run, overriding the one it would
   * inherit. `ParallelWorker` passes a signal it owns so it can stop the items
   * still in flight when one of them fails.
   */
  abortSignal?: AbortSignal;
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
   * both output and interrupts. On the engine seam rather than
   * {@link RunNodeOptions}, matching adk-python's `NodeRunner` constructor; the
   * consumer is `Workflow`'s resume path, which carries `prior.input` today.
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

  // A caller-supplied signal wins over the engine-supplied one (a Workflow uses
  // that to cancel siblings on failure), which in turn wins over the parent
  // invocation's. The caller chains its signal to the ones it displaces, so
  // preferring it does not detach the child from them.
  const effectiveAbortSignal =
    options.abortSignal ?? abortSignal ?? parent.invocationContext.abortSignal;

  const childIc =
    branch === parent.invocationContext.branch &&
    effectiveAbortSignal === parent.invocationContext.abortSignal &&
    isolationScope === parent.invocationContext.isolationScope &&
    nodePath === parent.invocationContext.nodePath
      ? parent.invocationContext
      : new InvocationContext({
          ...parent.invocationContext,
          branch,
          abortSignal: effectiveAbortSignal,
          isolationScope,
          nodePath,
        });

  // Scoped to this run: an event may redirect the branch its successors
  // inherit, and `childIc` is often the parent's own context (see BranchRef).
  const branchRef: BranchRef = {value: branch, initial: branch};

  const child = new NodeContext({
    invocationContext: childIc,
    channel: parent.channel,
    nodePath,
    runId,
    resumeInputs: resumeInputs ?? parent.resumeInputs,
    isolationScope,
    // A node's own schema wins; otherwise it answers to its parent's.
    stateSchema: node.stateSchema ?? parent.stateSchema,
    parentCtx: parent,
    node,
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
      resetState(child, branchRef);
      // Per attempt, not once before the loop: `resetState` clears exactly
      // these fields, and adk-python rebuilds the child context per attempt for
      // the same reason. A carried-forward output was emitted last turn, so it
      // must not be flushed again.
      if (priorOutput !== undefined) {
        child.output = priorOutput;
        child.outputEmitted = true;
      }
      for (const id of priorInterruptIds ?? []) {
        if (!child.interruptIds.includes(id)) {
          child.interruptIds.push(id);
        }
      }
      child.attemptCount = nodeState.attemptCount;
      try {
        inputRecorded = await runAttempt({
          node,
          child,
          input,
          nodeName,
          branch: branchRef,
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
        const willRetry =
          !!retryConfig &&
          shouldRetryNode({error: err, retryConfig, nodeState});
        // Report the failure here, so a node run through ctx.runNode outside a
        // Workflow still records it: one event per attempt, and none for a
        // failure an outer node only passed through.
        reportAttemptFailure({
          error: err,
          child,
          nodeName,
          branch: branchRef,
          isolationScope,
          attemptCount: nodeState.attemptCount,
          isFinalAttempt: !willRetry,
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
      recordInputForResume({
        child,
        nodeName,
        branch: branchRef,
        isolationScope,
        input,
      });
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
      flushOutputAndDeltas({
        child,
        nodeName,
        branch: branchRef,
        isolationScope,
      });
    }

    if (options.useAsOutput) {
      parent.output = child.output;
      // The setter clears `routeEmitted`, so restore what the child recorded:
      // the child's own event already carried the route.
      parent.route = child.route;
      parent.routeEmitted = child.routeEmitted;
      // `ctx.runNode` claims the delegate before the child runs; this covers
      // the engine's own direct calls, which do not go through it.
      parent.outputDelegated = true;
    }

    return child;
  } catch (err) {
    // Recorded on the child before the throw travels on, so a node body holding
    // its own context can report what failed. A failure that started deeper
    // keeps that node's path rather than adopting this one's.
    child.error = err instanceof Error ? err : new Error(String(err));
    child.errorNodePath = isDynamicNodeFailError(err)
      ? err.errorNodePath
      : child.nodePath;
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
 * failed attempt can leave behind on the child context: its output/route, who
 * has already reported them, interrupt ids, any branch it redirected, AND its
 * state and artifact writes. A node that calls `ctx.state.set(...)`
 * and then throws would otherwise leave the failed attempt's writes in the
 * delta, to be committed alongside the successful attempt's. `NodeContext`
 * builds its `State` over this exact `stateDelta` object once (in its
 * constructor), so we clear the keys in place rather than reassigning it. The
 * same goes for its artifact deltas, its output flags and a requested agent
 * transfer — everything adk-python discards by building a fresh child context
 * per attempt.
 *
 * The reporting flags matter as much as the values. Every one of them is raised
 * during an attempt — by an event this node emitted, or by a child it ran with
 * `useAsOutput` — so a flag left standing describes work the failed attempt
 * did, and would suppress the successful attempt's own output event. adk-python
 * has no such flag to clear because it builds a fresh context per attempt.
 *
 * Note: events already pushed through the channel on a failed attempt are
 * downstream and cannot be retracted, so a node that emits N events and
 * then fails re-emits those N on retry (see the note on `executeChildNode`).
 *
 * @param childNodeContext Node context to reset
 */
function resetState(childNodeContext: NodeContext, branch: BranchRef): void {
  childNodeContext.output = undefined;
  childNodeContext.outputEmitted = false;
  childNodeContext.outputDelegated = false;
  // The setter clears `routeEmitted`.
  childNodeContext.route = undefined;
  childNodeContext.interruptIds = [];
  childNodeContext.reportedError = undefined;
  childNodeContext.error = undefined;
  childNodeContext.errorNodePath = '';
  childNodeContext.outputEmitted = false;
  childNodeContext.routeEmitted = false;
  childNodeContext.outputDelegated = false;
  childNodeContext.actions.transferToAgent = undefined;
  branch.value = branch.initial;
  clearInPlace(childNodeContext.actions.stateDelta);
  clearInPlace(childNodeContext.actions.artifactDelta);
}

/**
 * The branch in force for the rest of a node's run.
 *
 * An event can redirect the branch its successors inherit, so the value has to
 * outlive the single {@link enrichEvent} call that changes it. It is held in a
 * holder rather than on `child.invocationContext`, because `runChildNode`
 * reuses the parent's `InvocationContext` when nothing differs — mutating it
 * there would leak a child's branch into the parent.
 */
interface BranchRef {
  /** The branch in force right now. An event can redirect it. */
  value: string | undefined;
  /**
   * The branch the run started on. A retry restores it, so a redirect a failed
   * attempt made is discarded with the rest of that attempt's state — matching
   * adk-python, which builds a fresh child context per attempt.
   */
  readonly initial: string | undefined;
}

interface RunOnceParams {
  node: BaseNode;
  child: NodeContext;
  input: unknown;
  nodeName: string;
  branch: BranchRef;
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
    // Read before `enrichEvent`, which stamps the node's own name onto an
    // unauthored event: after it, every event looks native and the guard below
    // never fires.
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
        // Nothing but the output, which the delegate already emitted: drop
        // the event entirely rather than pushing an emptied one.
        if (!hasNonOutputContent(event)) {
          return;
        }
        event.output = undefined;
        event.content = undefined;
      }
    } else if (event.nodeInfo?.messageAsOutput) {
      child.output = event.content;
    }
    // Only a native event's decisions belong to this node: a structured parent
    // (a sequential agent, say) must not bubble up a route or a transfer one of
    // its nested sub-agents already handled.
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
    // A partial event is a fragment of the one that follows it, so the pending
    // deltas roll forward and ride the next complete event instead.
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

/** Whether a delta object holds at least one entry. */
function hasEntries(delta: Record<string, unknown> | undefined): boolean {
  return !!delta && Object.keys(delta).length > 0;
}

/** Removes every key from a delta object, keeping the object itself. */
function clearInPlace(delta: Record<string, unknown>): void {
  for (const key of Object.keys(delta)) {
    delete delta[key];
  }
}

/**
 * Whether an event carries anything besides its output, and so is still worth
 * pushing once a delegated output is stripped from it. Mirrors adk-python's
 * `_has_non_output_content`.
 */
function hasNonOutputContent(event: Event): boolean {
  return (
    hasEntries(event.actions?.stateDelta) ||
    hasEntries(event.actions?.artifactDelta)
  );
}

/**
 * Moves the node's pending state and artifact deltas onto an event, then clears
 * them so the next event does not report the same writes again.
 *
 * Keys the event already carries win: those are the node's own writes on the
 * event it yielded, and `FunctionNode.toEvent` resolves the same overlap the
 * same way. `mergeEventActions` does the merge, so the write-order stamps
 * travel with the entries and a later commit still knows which write came
 * first. The pending entries are cleared in place, because `NodeContext` builds
 * its `State` over that exact `stateDelta` object.
 */
function flushDeltas(event: Event, child: NodeContext): void {
  const {stateDelta, artifactDelta} = child.actions;
  if (!hasEntries(stateDelta) && !hasEntries(artifactDelta)) {
    return;
  }
  // The event is the later source, so its own value wins for a key both carry.
  event.actions = mergeEventActions([
    {stateDelta, artifactDelta},
    event.actions ?? {},
  ]);
  clearInPlace(stateDelta);
  clearInPlace(artifactDelta);
}

interface FlushOutputAndDeltasParams {
  child: NodeContext;
  nodeName: string;
  branch: BranchRef;
  isolationScope: string | undefined;
}

/**
 * Emits the node's deferred output, its unflushed route and any still-pending
 * delta as one event, once the node has finished running.
 *
 * A node that assigns `ctx.output` instead of yielding it, or that writes
 * `ctx.state` after its last event, produces a result the session would
 * otherwise never see: the value reaches the graph in memory, but a resumed run
 * reads the events. Nothing is emitted when the node already put all of it on
 * an event, which is the ordinary case. Mirrors adk-python's
 * `_flush_output_and_deltas`.
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
  const hasDeltas =
    hasEntries(child.actions.stateDelta) ||
    hasEntries(child.actions.artifactDelta);
  if (!hasDeferredOutput && !hasUnflushedRoute && !hasDeltas) {
    return;
  }

  const event = createEvent({
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

interface ReportAttemptFailureParams {
  error: unknown;
  child: NodeContext;
  nodeName: string;
  branch: BranchRef;
  isolationScope: string | undefined;
  attemptCount: number;
  isFinalAttempt: boolean;
  abortSignal: AbortSignal | undefined;
}

/**
 * Emits one error event for an attempt that failed, so a failure that is
 * retried leaves its own trace instead of only the attempt that finally threw.
 *
 * A failure already reported in this invocation is left alone: the node that
 * reported it itself, and the one that threw it below this node, each already
 * put an event in the stream. The final failure is claimed here, which is what
 * stops `Workflow.reportNodeError` from reporting it a second time.
 */
function reportAttemptFailure({
  error,
  child,
  nodeName,
  branch,
  isolationScope,
  attemptCount,
  isFinalAttempt,
  abortSignal,
}: ReportAttemptFailureParams): void {
  // A node that failed because the run was cancelled did not really fail, and
  // adk-js keeps cancellation silent (`Workflow.reportNodeError` skips it too).
  if (abortSignal?.aborted || isNodeErrorReported(error, child.invocationId)) {
    return;
  }
  if (isFinalAttempt) {
    claimNodeErrorReport(error, child.invocationId);
  }
  const event = createNodeErrorEvent({
    error,
    attemptCount,
    author: nodeName,
    invocationId: child.invocationId,
    branch: branch.value,
    isolationScope,
  });
  enrichEvent({event, child, nodeName, branch, isolationScope});
  child.channel.push(event);
}

interface RecordInputForResumeParams {
  child: NodeContext;
  nodeName: string;
  branch: BranchRef;
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
    branch: branch.value,
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
  branch: BranchRef;
  isolationScope: string | undefined;
}

/**
 * Stamps engine-owned provenance onto an event.
 *
 * `author`, `branch` and `isolationScope` are only filled in when the node left
 * them unset, so a node can override them. `path` is different: it is
 * engine-owned and always set to the child's real node path — a node must not be
 * able to misreport where it ran.
 *
 * The author defaults to `ctx.eventAuthor` when something set one — an agent
 * run as a node records its own — and to the node's own name otherwise.
 *
 * A branch the node set on the event also redirects `branch` for the rest of
 * the run: an empty string clears the branch, and any other value becomes the
 * one later events inherit.
 */
function enrichEvent({
  event,
  child,
  nodeName,
  branch,
  isolationScope,
}: EnrichEventParams): void {
  if (!event.author) {
    event.author = child.eventAuthor || nodeName;
  }
  if (!event.invocationId) {
    event.invocationId = child.invocationId;
  }
  // Engine-owned: always stamp the true node path (see doc above).
  event.nodeInfo = {...(event.nodeInfo ?? {}), path: child.nodePath};
  if (event.output !== undefined) {
    event.nodeInfo.outputFor = [child.nodePath, ...child.outputForAncestors];
  }
  if (event.branch === undefined) {
    event.branch = branch.value;
  } else if (event.branch === '') {
    event.branch = undefined;
    branch.value = undefined;
  } else {
    branch.value = event.branch;
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
