/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isBaseAgent} from '../agents/base_agent.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {createEventActions, EventActions} from '../events/event_actions.js';
import {State} from '../sessions/state.js';
import {AsyncQueue} from '../utils/async_queue.js';
import type {SchemaLike} from '../utils/schema.js';
import type {BaseNode} from './base_node.js';
import {NodeInterruptedError} from './errors.js';
import type {RouteValue, RunnableNode} from './graph.js';
import {executeChildNode, RunNodeOptions} from './node_runner.js';
import type {ScheduleDynamicNode} from './schedule_dynamic_node.js';
import {
  MAX_PARENT_DEPTH,
  resolveAndDeriveTransferContext,
} from './utils/transfer_utils.js';
import {buildNode} from './utils/workflow_graph_utils.js';
import {isWorkflow} from './workflow.js';

/**
 * The result of running a node: the fields a caller (and the engine's
 * completion handling) reads off a finished run — its `output`, emitted
 * `route`, the `branch` it ran on, and any raised interrupt ids.
 *
 * A node that actually executes returns its full {@link NodeContext} (which
 * satisfies this shape). A node that is *fast-forwarded* on resume (its output
 * was cached in a prior turn, so its body is not re-run) returns a bare
 * `NodeResult` with no live context behaviour — so callers of `ctx.runNode()`
 * should treat the result as a `NodeResult` and read only these fields.
 */
export interface NodeResult {
  /** The structured output the node produced (if any). */
  output: unknown;
  /** The route key(s) the node emitted, if any (array = multi-route). */
  route?: RouteValue | RouteValue[];
  /** The branch the node ran on. */
  branch?: string;
  /** Interrupt ids the node is blocked on (empty when it completed). */
  interruptIds: string[];
}

/**
 * Options for constructing a {@link NodeContext}.
 */
export interface NodeContextOptions {
  invocationContext: InvocationContext;
  channel: AsyncQueue<Event>;
  /** Dotted node path of the owning node (empty string for the root). */
  nodePath: string;
  /** Deterministic run id of the owning node. */
  runId: string;
  /** Responses for resuming interrupted child nodes, keyed by interrupt id. */
  resumeInputs?: Record<string, unknown>;
  /** Scope tag isolating this node's events from peer scopes. */
  isolationScope?: string;
  /** Accumulator for event actions (state delta, etc). */
  actions?: EventActions;
  /**
   * Declares the keys this node may write to `ctx.state` and their types.
   * Resolved by the runner: the node's own schema, or the parent's.
   */
  stateSchema?: SchemaLike;
  /** The context that ran this one; absent for a root context. */
  parentCtx?: NodeContext;
  /** The node this context belongs to; absent for a root context. */
  node?: BaseNode;
}

/**
 * The execution context for a workflow node — the TypeScript analogue of
 * `google/adk-python` `agents/context.py::Context` (the workflow flavour).
 *
 * It exposes `ctx.runNode(...)` for programmatic child execution, `ctx.state`
 * for delta-aware session state, `ctx.emit(...)` to stream an event, and the
 * mutable `output`/`route`/`interruptIds` a node sets while running.
 */
export class NodeContext {
  readonly invocationContext: InvocationContext;
  readonly channel: AsyncQueue<Event>;
  readonly nodePath: string;
  readonly runId: string;

  /** The context that ran this one; `undefined` for a root context. */
  readonly parentCtx?: NodeContext;

  /** The node this context belongs to; `undefined` for a root context. */
  readonly node?: BaseNode;

  /**
   * Node paths whose output this node's output also becomes: its parent's if
   * the parent ran it with `useAsOutput`, plus whatever the parent was standing
   * in for. Stamped onto every output event as `nodeInfo.outputFor`, so a
   * resumed run can tell that an ancestor already has a result.
   */
  outputForAncestors: readonly string[] = [];

  /**
   * Whether this node handed its output to a child run with `useAsOutput`.
   *
   * The child already emitted that value as its own result, so an event from
   * this node repeating it would put the same text in the stream twice. The
   * node still reports the output — only the duplicate event is suppressed.
   */
  outputDelegated = false;

  /**
   * Whether this node's output has already gone out on an event.
   *
   * Engine-owned: the runner sets it when it pushes an event carrying the
   * output, and reads it once the node finishes to decide whether an output the
   * node only assigned to `ctx.output` still needs an event of its own. Mirrors
   * adk-python's `Context._output_emitted`.
   */
  outputEmitted = false;

  /**
   * Whether this node's route has already gone out on an event. The engine
   * counterpart of {@link outputEmitted}, for `ctx.route`. Mirrors adk-python's
   * `Context._route_emitted`.
   */
  routeEmitted = false;
  readonly actions: EventActions;
  resumeInputs: Record<string, unknown>;
  isolationScope?: string;

  /** The structured output produced by the node during its run. */
  output: unknown = undefined;

  /** The route key(s) emitted by the node, if any (array = multi-route). */
  route?: RouteValue | RouteValue[];

  /** Interrupt ids the node is currently blocked on (HITL). */
  interruptIds: string[] = [];

  /**
   * The failure that ended this node's run, recorded by the engine before it
   * re-throws. Cleared per attempt.
   */
  error?: Error;

  /**
   * The path of the node that actually failed, which is this node only when the
   * failure started here: a failure raised by a `ctx.runNode` child keeps the
   * child's path as it travels up. Empty while the node has not failed.
   */
  errorNodePath = '';

  /**
   * The author stamped on events this node leaves unattributed, in place of the
   * node's own name. An agent run as a node records its own author here, so a
   * later event it emits without one still reads as the agent's. Inherited from
   * {@link parentCtx}; empty means "use the node's name".
   */
  eventAuthor: string;

  /**
   * The failure a node reported by emitting an error event rather than by
   * throwing. Read back at the end of the attempt; cleared per attempt.
   */
  reportedError?: {errorCode?: string; errorMessage?: string};

  /**
   * Abort signal for the current node run, set by the engine while the node is
   * executing under a deadline or an external cancellation signal — i.e. when
   * the node declares a `timeout`, when the invocation itself can be aborted, or
   * when it runs inside a Workflow (whose signal fires if a sibling fails).
   * Cooperative node bodies can observe `ctx.abortSignal` to wind down their own
   * in-flight work (e.g. pass it to a model/tool call); the engine also stops
   * consuming the node's events once it fires, so nothing is pushed past
   * cancellation. A fired `timeout` surfaces as a `NodeTimeoutError`; an external
   * abort stops the node without raising.
   */
  abortSignal?: AbortSignal;

  /**
   * The dynamic-node scheduler for this subtree. When set, `ctx.runNode()`
   * routes through it (dedup/resume/fresh); otherwise it runs the child
   * directly. Propagated to child contexts by the node runner; a nested
   * Workflow overrides it with its own scheduler.
   */
  scheduler?: ScheduleDynamicNode;

  /** The current attempt number (1-based) for the running node (see retry). */
  attemptCount = 1;

  /**
   * The state schema in force for this node, inherited by its children unless
   * they declare their own.
   */
  readonly stateSchema?: SchemaLike;

  private readonly _state: State;
  private readonly dynamicRunCounters = new Map<string, number>();
  /** Run ids this context handed out automatically, per node name. */
  private readonly autoRunIds = new Map<string, Set<string>>();
  /**
   * Caller-supplied run ids shaped like an automatic one (all digits), per node
   * name — the set {@link assertNoNumericCustomRunIds} refuses to auto-number
   * around.
   */
  private readonly numericCustomRunIds = new Map<string, Set<string>>();

  constructor(opts: NodeContextOptions) {
    this.invocationContext = opts.invocationContext;
    this.channel = opts.channel;
    this.nodePath = opts.nodePath;
    this.runId = opts.runId;
    this.parentCtx = opts.parentCtx;
    this.node = opts.node;
    this.eventAuthor = opts.parentCtx?.eventAuthor ?? '';
    this.resumeInputs = opts.resumeInputs ?? {};
    this.isolationScope = opts.isolationScope;
    this.actions = opts.actions ?? createEventActions();
    // Writes via `ctx.state` accumulate into `actions.stateDelta`, mirroring
    // Python's `ctx.state` -> `ctx.actions.state_delta` behaviour, and land in
    // `session.state` at once so a reader outside the workflow — an agent
    // resolving a `{key}` instruction, a callback, a tool — sees them.
    this.stateSchema = opts.stateSchema;
    this._state = new State(
      opts.invocationContext.session.state,
      this.actions.stateDelta,
      opts.stateSchema,
    );
  }

  /** Delta-aware session state; writes accumulate in `actions.stateDelta`. */
  get state(): State {
    return this._state;
  }

  /** The branch of the owning invocation context. */
  get branch(): string | undefined {
    return this.invocationContext.branch;
  }

  /** The current invocation id. */
  get invocationId(): string {
    return this.invocationContext.invocationId;
  }

  /** The current session. */
  get session() {
    return this.invocationContext.session;
  }

  /**
   * The invocation context to run a nested agent against.
   *
   * The single place where "what a node sees" is translated into "what an
   * agent sees", so an agent run as a node (`BaseAgent.runImpl`) and one run
   * directly go through the same seam.
   *
   * It hands back the node's own invocation context unchanged, and that is the
   * intended behaviour rather than a placeholder.
   *
   * adk-python's counterpart (`agents/context.py` `get_invocation_context`) is
   * documented as returning "a copy with the proxy session", which reads as
   * though the agent is handed a different view of state. It is not: that
   * `Context.session` returns `self._invocation_context.session`, so the copy
   * substitutes the same object, and `Context._state` is built directly over
   * `session.state`. A Python agent run as a node reads session state exactly
   * as a TypeScript one does.
   *
   * The other thing that copy carries — the isolation scope — is already
   * applied by the time this runs: the node runner builds the child invocation
   * context with the node's scope, so it is present on the object returned.
   *
   * That leaves the node's own `state`, which is this node's pending delta over
   * `session.state` — the same thing an agent reads, so the two cannot
   * disagree. The agent-node cases in
   * `core/test/workflow/state_consistency_test.ts` pin that.
   */
  getInvocationContext(): InvocationContext {
    return this.invocationContext;
  }

  /** Streams a single event out through the workflow's event channel. */
  emit(event: Event): void {
    this.channel.push(event);
  }

  /**
   * Runs a child node programmatically, streaming its events through the same
   * channel and resolving to the child's result — a full {@link NodeContext}
   * for a node that actually ran, or a bare {@link NodeResult} for one that was
   * fast-forwarded from cached output on resume. Either way the caller can read
   * `output`, `route`, `branch`, and `interruptIds`; only a `NodeContext`
   * offers live behaviour (`emit`, `state`, nested `runNode`).
   *
   * When a dynamic-node {@link scheduler} is set (inside a Workflow subtree),
   * the call routes through it for dedup/resume; otherwise the child runs
   * directly.
   *
   * Takes anything an edge takes — an agent, a tool, a plain function, or an
   * already-built node — and wraps it the same way the graph does, so
   * `ctx.runNode(myAgent, input)` works without `node(myAgent)`. Wrap it
   * yourself when you need the options `node()` carries, such as a schema or a
   * name that differs from the value's own.
   *
   * An agent that asks to transfer to another agent (by setting
   * `actions.transferToAgent`) is followed here: the target is resolved against
   * the agent tree and run in place, and its result is what this call returns.
   *
   * Called from a node body, a child that failed or that stopped to ask the
   * user raises rather than returning, so the body cannot run on past it. A
   * root context built by a driver reads the child's state instead, and sees no
   * raise.
   */
  async runNode(
    nodeLike: RunnableNode,
    input?: unknown,
    options: RunNodeOptions = {},
  ): Promise<NodeContext | NodeResult> {
    // Output delegation is claimed before the child runs, not after: the
    // child's output event is annotated as answering for this node too, so a
    // second delegate would produce two events both claiming to be this node's
    // result. A Workflow is exempt — it delegates to each of its nodes in turn.
    if (options.useAsOutput && !isWorkflow(this.node)) {
      if (this.outputDelegated) {
        throw new Error(
          `Node ${this.nodePath} already has a use_as_output delegate.`,
        );
      }
      this.outputDelegated = true;
    }

    return NodeContext.runFollowingTransfers(
      this,
      buildNode(nodeLike),
      input,
      options,
    );
  }

  /**
   * Runs `node` under `origin`, and keeps running whatever agent the result
   * asks to transfer to until one finishes without asking.
   *
   * A transfer moves execution to another context, so the caller's context is
   * a loop pointer rather than `this` — hence the explicit `origin` parameter.
   */
  private static async runFollowingTransfers(
    origin: NodeContext,
    node: BaseNode,
    input: unknown,
    options: RunNodeOptions,
  ): Promise<NodeContext | NodeResult> {
    let currParentCtx = origin;
    let currNode = node;
    let currRunId = options.runId;
    let currInput = input;

    for (let hop = 0; hop < MAX_PARENT_DEPTH; hop++) {
      const child = await currParentCtx.runChild(currNode, currInput, {
        ...options,
        // Only the original caller's own output is delegated; once a transfer
        // has moved execution under another context, that context is not
        // standing in for the original one.
        useAsOutput: options.useAsOutput && currParentCtx === origin,
        runId: currRunId,
      });

      const childCtx = isNodeContext(child) ? child : undefined;
      const transferTo = childCtx?.actions.transferToAgent;
      currParentCtx.raiseIfChildInterrupted(child);
      if (childCtx === undefined || transferTo === undefined) {
        return child;
      }

      if (!isBaseAgent(currNode)) {
        throw new Error('Only agents can request an agent transfer.');
      }
      const next = resolveAndDeriveTransferContext({
        targetName: transferTo,
        currentAgent: currNode,
        rootAgent: currNode.rootAgent,
        currCtx: childCtx,
        currParentCtx,
      });
      currParentCtx = next.nextParentCtx;
      currNode = next.targetAgent;
      currRunId = undefined;
      currInput = undefined;
    }

    throw new Error(
      `Agent transfer from node ${origin.nodePath} exceeded ` +
        `${MAX_PARENT_DEPTH} hops; the agents are transferring in a cycle.`,
    );
  }

  /**
   * Runs one child, through the dynamic-node scheduler when this subtree has
   * one (for dedup and resume) and directly otherwise.
   */
  private runChild(
    node: BaseNode,
    input: unknown,
    options: RunNodeOptions,
  ): Promise<NodeContext | NodeResult> {
    if (!this.scheduler) {
      return executeChildNode({parent: this, node, input, options});
    }
    const nodeName = options.nodeName ?? node.name;
    return this.scheduler.schedule(this, node, input, {
      ...options,
      nodeName,
      runId: this.claimRunId(nodeName, options.runId),
    });
  }

  /**
   * Returns the run id this child run is keyed by: the caller's, once checked
   * against the automatic numbering namespace, or the next automatic number.
   */
  private claimRunId(nodeName: string, runId: string | undefined): string {
    if (runId !== undefined) {
      assertCustomRunId(runId, nodeName, mapSet(this.autoRunIds, nodeName));
      if (isAutoNumberShaped(runId)) {
        mapSet(this.numericCustomRunIds, nodeName).add(runId);
      }
    }
    if (runId) {
      return runId;
    }
    assertNoNumericCustomRunIds(
      nodeName,
      mapSet(this.numericCustomRunIds, nodeName),
    );
    // No need to skip ids a caller already claimed: the counter is monotonic,
    // so the next value was never handed out automatically, and a custom id
    // that could equal it is refused by the two asserts above.
    const next = (this.dynamicRunCounters.get(nodeName) ?? 0) + 1;
    this.dynamicRunCounters.set(nodeName, next);
    const claimed = String(next);
    mapSet(this.autoRunIds, nodeName).add(claimed);
    return claimed;
  }

  /**
   * Raises when a finished child leaves this node unable to continue: it
   * stopped to ask the user and nobody has answered yet.
   *
   * A node body must not run on past such a child: everything after the call
   * would run on a missing answer, and would run again when the turn resumes.
   * Copying the child's interrupt ids here first is what lets the runner
   * catching the throw record this node as waiting rather than failed.
   *
   * A root context has no {@link node} and is therefore not a node body but a
   * driver — `runNodeAsInvocation`, `NodeTool`, a caller of its own — which
   * awaits the child and reads its state directly. Raising at a driver would
   * turn a paused run into a failed one, so it is skipped there. This is the
   * split adk-python spells `return_ctx` on `Context._run_node_internal`.
   */
  private raiseIfChildInterrupted(child: NodeContext | NodeResult): void {
    if (!this.node || child.interruptIds.length === 0) {
      return;
    }
    for (const id of child.interruptIds) {
      if (!this.interruptIds.includes(id)) {
        this.interruptIds.push(id);
      }
    }
    throw new NodeInterruptedError();
  }
}

/**
 * Whether a finished child run is a live context rather than a bare result
 * fast-forwarded from a checkpoint. Structural, not `instanceof`, so it stays
 * correct when two copies of adk-js share a runtime.
 */
function isNodeContext(child: NodeContext | NodeResult): child is NodeContext {
  return 'actions' in child;
}

/** Returns the set stored under `key`, creating it on first use. */
function mapSet(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

/** Whether a run id is shaped like one of ADK's own: nothing but digits. */
function isAutoNumberShaped(runId: string): boolean {
  return /^\d+$/.test(runId);
}

/** The shared explanation for mixing numeric custom ids with auto-numbering. */
function numericRunIdMixError(nodeName: string, runId: string): Error {
  return new Error(
    `Invalid runId '${runId}' for node '${nodeName}': ADK numbers automatic ` +
      `runs of a node "1", "2", "3", … per context, so an all-digit custom ` +
      `id draws from that same namespace. A later turn that issues a ` +
      `different set of custom ids shifts the automatic sequence onto a ` +
      `checkpoint path an earlier call already wrote, and the call is ` +
      `fast-forwarded to that run's cached output with its own input ` +
      `silently discarded. Give the custom id a non-numeric part, e.g. ` +
      `'${nodeName}-${runId}', or supply an explicit id for every run of ` +
      `this node so ADK never numbers one.`,
  );
}

/**
 * Rejects a caller-supplied run id that shares the automatic numbering
 * namespace for a node ADK also numbers automatically.
 *
 * Run ids key the checkpoint lookup that lets a resumed or retried workflow
 * skip work it already did, so an id that names a run the caller never made is
 * silently wrong: the scheduler finds the earlier run's checkpoint, returns
 * *its* output, and the input passed here is dropped without executing.
 * Nothing downstream can detect that, so it is refused at the call.
 *
 * The refusal is symmetric with {@link assertNoNumericCustomRunIds}, which
 * covers the other order. Checking only for an id already handed out made the
 * guard depend on which call ran first: the same program was a hard error when
 * the automatic run came first and silent data corruption when it came second.
 *
 * Digits are refused only for a node that is *also* auto-numbered here, which
 * is what makes them ambiguous. A caller that names every run itself owns the
 * whole namespace and cannot collide with anything — `ParallelWorker` keys its
 * fan-out by item index that way. Reusing a custom id deliberately stays a
 * supported way to dedup concurrent calls onto one run.
 */
function assertCustomRunId(
  runId: string,
  nodeName: string,
  autoRunIds: ReadonlySet<string>,
): void {
  if (runId.trim() === '') {
    throw new Error(
      `Invalid runId for node '${nodeName}': a custom run id cannot be empty. ` +
        `Omit runId to let ADK number the run automatically.`,
    );
  }
  if (autoRunIds.size > 0 && isAutoNumberShaped(runId)) {
    throw numericRunIdMixError(nodeName, runId);
  }
}

/**
 * Refuses to number a run automatically once an all-digit custom id has been
 * claimed for the same node.
 *
 * The mirror image of {@link assertCustomRunId}, and the case the guard used to
 * miss. Numbering around the claimed id looks harmless within one turn — it
 * skips to the next free number and everything runs — but the number it skips
 * to is a function of how many custom ids this turn happened to issue. Issue
 * one fewer next turn and the automatic call lands on a path a custom run
 * already wrote, and is answered from that checkpoint instead of executing.
 */
function assertNoNumericCustomRunIds(
  nodeName: string,
  numericCustomRunIds: ReadonlySet<string>,
): void {
  const first = numericCustomRunIds.values().next();
  if (!first.done) {
    throw numericRunIdMixError(nodeName, first.value);
  }
}
