/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';
import {experimental} from '../utils/experimental.js';
import {BaseNode, BaseNodeConfig} from './base_node.js';
import {NodeLike} from './graph.js';
import {PARALLEL_WORKER_FACTORY} from './node_builders.js';
import {NodeContext} from './node_context.js';
import {
  assertParallelWorkerOptions,
  buildNode,
  BuildNodeOptions,
  copyNodeWithPrototype,
  isBuildNodeOptions,
} from './utils/workflow_graph_utils.js';

/** Options accepted by {@link node}. */
export type NodeOptions = BuildNodeOptions;

/** Configuration for a {@link WorkflowNode}. */
export interface WorkflowNodeConfig extends BaseNodeConfig {
  /**
   * Runs this node once per item of a list input, through a `ParallelWorker`,
   * and emits the ordered list of the results. Forces `rerunOnResume`, which is
   * what the worker itself sets.
   */
  parallelWorker?: boolean;

  /** Concurrency limit for the fan-out. Requires `parallelWorker`. */
  maxParallelWorkers?: number;
}

/**
 * Validates the parallel-worker option pair, then forces `rerunOnResume` on a
 * node that fans out, matching the value `ParallelWorker` sets on itself.
 */
function withParallelWorkerDefaults(
  config: WorkflowNodeConfig,
): WorkflowNodeConfig {
  assertParallelWorkerOptions(config);
  return config.parallelWorker ? {...config, rerunOnResume: true} : config;
}

/**
 * Wraps a {@link NodeLike} (function, tool, agent, or existing node) into a
 * {@link BaseNode}, optionally overriding its properties.
 *
 * Called with options alone — or with nothing — it returns a wrapper that
 * builds the node later. That is the portable half of Python's `@node(...)`
 * decorator: TypeScript decorators apply only to classes and class elements, so
 * `@node` on a function has no counterpart here.
 *
 * ```ts
 * const a = node(myFunction, {name: 'classify'});
 * const b = node(myTool);
 * const c = node({name: 'classify'})(myFunction);
 * const d = node({parallelWorker: true, maxParallelWorkers: 3})(myFunction);
 * ```
 *
 * Ported from `google/adk-python` `workflow/_node.py::node`.
 */
export function node(options?: NodeOptions): (nodeLike: NodeLike) => BaseNode;
export function node(nodeLike: NodeLike, options?: NodeOptions): BaseNode;
export function node(
  nodeLikeOrOptions?: NodeLike | NodeOptions,
  options: NodeOptions = {},
): BaseNode | ((nodeLike: NodeLike) => BaseNode) {
  if (
    nodeLikeOrOptions === undefined ||
    isBuildNodeOptions(nodeLikeOrOptions)
  ) {
    const factoryOptions = nodeLikeOrOptions ?? {};
    // Reject the pair here, so the call that got it wrong is the one that
    // throws rather than the later application of the wrapper.
    assertParallelWorkerOptions(factoryOptions);
    return (nodeLike: NodeLike) => buildNode(nodeLike, factoryOptions);
  }
  return buildNode(nodeLikeOrOptions, options);
}

/**
 * A base class designed for subclassing. Implement {@link runNodeImpl} to
 * provide node logic; subclasses inherit the schema/retry/timeout machinery of
 * {@link BaseNode}.
 *
 * Named `WorkflowNode` (not `Node`) to read consistently with `Workflow` and
 * `WorkflowConfig`, and to avoid shadowing the DOM / `@types/node` `Node`
 * global in the flat `@google/adk` namespace. The {@link node} factory remains
 * the ergonomic way to wrap a function/tool/agent.
 *
 * With `parallelWorker`, the node runs once per item of a list input and emits
 * the ordered list of the results — the subclass keeps its class and its own
 * fields on every item, because the worker wraps a copy of the node itself.
 * See `docs/guides/workflow/node/index.md`.
 *
 * Mirrors `google/adk-python` `workflow/_node.py::Node`.
 */
@experimental
export abstract class WorkflowNode<
  TInput = unknown,
  TOutput = unknown,
> extends BaseNode<TInput, TOutput> {
  readonly parallelWorker: boolean;
  readonly maxParallelWorkers?: number;

  constructor(config: WorkflowNodeConfig) {
    super(withParallelWorkerDefaults(config));
    this.parallelWorker = config.parallelWorker ?? false;
    this.maxParallelWorkers = config.maxParallelWorkers;
  }

  /**
   * Builds the fan-out wrapper around a copy of this node that does not fan
   * out, or returns `undefined` when the build has no `ParallelWorker`.
   *
   * Called per run rather than from the constructor: a base constructor runs
   * before a subclass assigns its own fields, so a wrapper built there would
   * carry a copy whose subclass fields are all still `undefined`.
   */
  protected createParallelWorker(): BaseNode | undefined {
    return PARALLEL_WORKER_FACTORY?.(
      copyNodeWithPrototype(this, {parallelWorker: false}),
      {maxParallelWorkers: this.maxParallelWorkers},
    );
  }

  /**
   * Implement node execution logic here. May yield `Event`s, raw values, or
   * `null` (normalized by {@link BaseNode.run}). Under `parallelWorker` it is
   * called once per item of the list input.
   */
  protected abstract runNodeImpl(
    ctx: NodeContext,
    input: TInput,
  ): AsyncGenerator<Event | TOutput | unknown, void, void>;

  protected async *runImpl(
    ctx: NodeContext,
    input: TInput,
  ): AsyncGenerator<Event | TOutput | unknown, void, void> {
    if (!this.parallelWorker) {
      yield* this.runNodeImpl(ctx, input);
      return;
    }
    const inner = this.createParallelWorker();
    if (!inner) {
      throw new Error('innerNode is not initialized for parallel worker.');
    }
    yield* inner.run(ctx, input);
  }
}
