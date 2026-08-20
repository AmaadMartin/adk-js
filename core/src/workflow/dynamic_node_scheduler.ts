/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseNode} from './base_node.js';
import {
  DynamicNodeFailError,
  isDynamicNodeFailError,
  isNodeInterruptedError,
} from './errors.js';
import type {NodeContext, NodeResult} from './node_context.js';
import {executeChildNode} from './node_runner.js';
import {createNodeState} from './node_state.js';
import {NodeStatus} from './node_status.js';
import type {
  DynamicNodeRun,
  DynamicNodeState,
  ScheduleDynamicNode,
  ScheduleDynamicNodeOptions,
} from './schedule_dynamic_node.js';
import {
  eventsForCurrentRun,
  reconstructNodeStatesByPath,
} from './utils/rehydration_utils.js';
import {
  checkInterception,
  interceptedResult,
} from './utils/replay_interceptor.js';
import {sequenceKey} from './utils/replay_manager.js';

/**
 * Handles `ctx.runNode()` calls for a {@link Workflow} subtree: fresh
 * execution, deduplication of concurrent calls to the same node path, and
 * resumption from session events in the recorded completion order.
 *
 * Ported from `google/adk-python` `workflow/_dynamic_node_scheduler.py`.
 */
export class DynamicNodeScheduler implements ScheduleDynamicNode {
  /**
   * @param state Shared dynamic-node bookkeeping for this workflow subtree.
   * @param abortSignal Workflow-scoped cancellation signal, forwarded to each
   *   dynamic child so a workflow shutting down on error can cancel in-flight
   *   `ctx.runNode()` children too.
   */
  constructor(
    private readonly state: DynamicNodeState,
    private readonly abortSignal?: AbortSignal,
  ) {}

  /**
   * Runs a `ctx.runNode()` call and reports any interrupt it is still waiting
   * on to the caller's own context.
   *
   * A child's interrupt is the caller's problem: the caller cannot produce a
   * trustworthy result until the human answers, and until the engine knows the
   * caller is waiting it marks it COMPLETED and schedules its successor —
   * which then runs on the `undefined` the caller returned when it bailed out.
   * `ParallelWorker` has always copied its items' interrupt ids onto its own
   * context for exactly this reason; doing it here extends that to every
   * caller instead of only the one that remembered.
   *
   * Only unresolved interrupts arrive here. A child fast-forwarded from a
   * checkpoint, or handed a resolved reply as its output, reports none.
   */
  async schedule(
    ctx: NodeContext,
    node: BaseNode,
    input: unknown,
    options: ScheduleDynamicNodeOptions,
  ): Promise<NodeContext | NodeResult> {
    const result = await this.scheduleRun(ctx, node, input, options);
    for (const id of result.interruptIds) {
      if (!ctx.interruptIds.includes(id)) {
        ctx.interruptIds.push(id);
      }
    }
    return result;
  }

  private async scheduleRun(
    ctx: NodeContext,
    node: BaseNode,
    input: unknown,
    options: ScheduleDynamicNodeOptions,
  ): Promise<NodeContext | NodeResult> {
    const name = options.nodeName ?? node.name;
    const runId = options.runId;
    // A dynamic child's path segment carries its run id, so it names exactly
    // one run and the barrier's run number for it is always 1.
    const segment = `${name}@${runId}`;
    const nodePath = ctx.nodePath ? `${ctx.nodePath}.${segment}` : segment;

    if (ctx.nodePath) {
      this.state.replayManager.prepareParentSequenceBarrier(ctx, ctx.nodePath);
    }

    const result = await this.resolveRun(ctx, node, input, {
      name,
      runId,
      segment,
      nodePath,
      options,
    });
    // Every successful schedule releases the next child in the recorded order.
    // A child that threw does not: the workflow tears down on a dynamic node
    // failure anyway.
    this.state.replayManager.advanceSequence(
      ctx.nodePath,
      sequenceKey(segment, 1),
    );
    return result;
  }

  /** Dedups, replays, or freshly runs one `ctx.runNode()` call. */
  private async resolveRun(
    ctx: NodeContext,
    node: BaseNode,
    input: unknown,
    run: {
      name: string;
      runId: string;
      segment: string;
      nodePath: string;
      options: ScheduleDynamicNodeOptions;
    },
  ): Promise<NodeContext | NodeResult> {
    const {name, runId, segment, nodePath, options} = run;
    const existing = this.state.runs.get(nodePath);
    if (existing?.task) {
      // Deduplicate concurrent calls: await the in-flight task.
      return existing.task;
    }
    if (existing?.result) {
      // Already settled this turn without executing its body. Re-running it
      // here would discard the recorded run and duplicate its side effects.
      return this.handBack(ctx, existing.result, options);
    }

    // Cross-turn resume: rehydrate this dynamic run from the events of the run
    // still in progress (a run that already completed must not be replayed).
    const prior = reconstructNodeStatesByPath(
      eventsForCurrentRun(ctx.session?.events ?? [], ctx.invocationId),
    ).get(nodePath);
    const decision = checkInterception({
      node,
      prior,
      resumeInputs: ctx.resumeInputs,
    });
    if (!decision.shouldRun) {
      return this.completeWithoutRunning(
        ctx,
        {nodePath, segment, runId, options},
        interceptedResult(ctx, decision),
      );
    }
    // Otherwise (fresh, or waiting on an unresolved interrupt): resume inputs
    // were already merged into ctx.resumeInputs by the Workflow.
    return this.runFresh(ctx, node, input, name, runId, nodePath, options);
  }

  /**
   * Books a dynamic run that completed WITHOUT executing its body — either
   * fast-forwarded from a cached output or handed the resolved resume value —
   * and returns `result` for `ctx.runNode()` to give back to the caller, once
   * the recorded order reaches it.
   */
  private async completeWithoutRunning(
    ctx: NodeContext,
    run: {
      nodePath: string;
      segment: string;
      runId: string;
      options: ScheduleDynamicNodeOptions;
    },
    result: NodeResult,
  ): Promise<NodeResult> {
    this.state.runs.set(run.nodePath, {
      state: createNodeState({
        status: NodeStatus.COMPLETED,
        runId: run.runId,
        parentRunId: ctx.runId,
      }),
      output: result.output,
      result,
    });
    await this.state.replayManager.waitSequence(
      ctx.nodePath,
      sequenceKey(run.segment, 1),
    );
    return this.handBack(ctx, result, run.options);
  }

  /**
   * Applies a settled result to the caller's context and returns it, so a first
   * call and a repeat call for the same path are indistinguishable.
   */
  private handBack(
    ctx: NodeContext,
    result: NodeResult,
    options: ScheduleDynamicNodeOptions,
  ): NodeResult {
    if (options.useAsOutput) {
      ctx.output = result.output;
      ctx.route = result.route;
    }
    return result;
  }

  private async runFresh(
    ctx: NodeContext,
    node: BaseNode,
    input: unknown,
    name: string,
    runId: string,
    nodePath: string,
    options: ScheduleDynamicNodeOptions,
  ): Promise<NodeContext> {
    const run: DynamicNodeRun = {
      state: createNodeState({
        status: NodeStatus.RUNNING,
        input,
        runId,
        parentRunId: ctx.runId,
      }),
    };
    this.state.runs.set(nodePath, run);

    run.task = executeChildNode({
      parent: ctx,
      node,
      input,
      abortSignal: this.abortSignal,
      options: {
        nodeName: name,
        runId,
        overrideNodePath: nodePath,
        useAsOutput: options.useAsOutput,
        useSubBranch: options.useSubBranch,
        overrideBranch: options.overrideBranch,
        overrideIsolationScope: options.overrideIsolationScope,
      },
    });

    let childCtx: NodeContext;
    try {
      childCtx = await run.task;
    } catch (err) {
      if (isNodeInterruptedError(err) || isDynamicNodeFailError(err)) {
        throw err;
      }
      run.state.status = NodeStatus.FAILED;
      const error = err instanceof Error ? err : new Error(String(err));
      throw new DynamicNodeFailError({
        message: `Dynamic node ${name} failed: ${error.message}`,
        error,
        errorNodePath: nodePath,
      });
    }
    this.recordResult(run, childCtx, node);
    return childCtx;
  }

  private recordResult(
    run: DynamicNodeRun,
    childCtx: NodeContext,
    node: BaseNode,
  ): void {
    if (childCtx.interruptIds.length > 0) {
      run.state.status = NodeStatus.WAITING;
      run.state.interrupts = [...childCtx.interruptIds];
      childCtx.interruptIds.forEach((id) => this.state.interruptIds.add(id));
    } else if (
      node.waitForOutput &&
      childCtx.output === undefined &&
      childCtx.route === undefined
    ) {
      run.state.status = NodeStatus.WAITING;
    } else {
      run.state.status = NodeStatus.COMPLETED;
      run.output = childCtx.output;
    }
  }
}
