/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';
import {experimental} from '../utils/experimental.js';
import {BaseNode, BaseNodeConfig} from './base_node.js';
import {NodeLike} from './graph.js';
import {NodeContext} from './node_context.js';
import {
  assertParallelWorkerOptions,
  buildNode,
  BuildNodeOptions,
  copyNodeWithPrototype,
  isBuildNodeOptions,
} from './utils/workflow_graph_utils.js';

/**
 * A unique symbol branding {@link WorkflowNode} instances.
 *
 * {@link isWorkflowNode} matches on this brand rather than `instanceof` so a
 * node built by another copy of adk-js in the same runtime is still recognised
 * — mirroring the `Symbol.for('google.adk.*')` brands used across ADK.
 */
const WORKFLOW_NODE_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.workflow.workflowNode',
);

/** Options accepted by {@link node}. */
export type NodeOptions = BuildNodeOptions;

/** Configuration for a {@link WorkflowNode}. */
export interface WorkflowNodeConfig extends BaseNodeConfig {
  /**
   * Runs this node once per item of a list input, through a `ParallelWorker`,
   * and emits the ordered list of the results.
   */
  parallelWorker?: boolean;

  /** Concurrency limit for the fan-out. Requires `parallelWorker`. */
  maxParallelWorkers?: number;
}

/**
 * Wraps a {@link NodeLike} (function, tool, agent, or existing node) into a
 * {@link BaseNode}, optionally overriding its properties.
 *
 * Called with options alone — or with nothing — it returns a wrapper that
 * applies them to whatever it is given, which is the portable half of Python's
 * `@node(...)` decorator form. TypeScript decorators apply only to classes and
 * class elements, so `@node` on a function declaration is a syntax error and
 * has no equivalent here.
 *
 * ```ts
 * const a = node(myFunction, {name: 'classify'});
 * const b = node(myTool);
 * const asWorker = node({parallelWorker: true, maxParallelWorkers: 3});
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
    const wrapperOptions = nodeLikeOrOptions ?? {};
    // adk-python rejects the option pair when the decorator factory is created,
    // before it is applied, so the call that got it wrong is the one that
    // throws.
    assertParallelWorkerOptions(wrapperOptions);
    return (nodeLike: NodeLike) => buildNode(nodeLike, wrapperOptions);
  }
  return buildNode(nodeLikeOrOptions, options);
}

/**
 * A base class designed for subclassing. Implement {@link runNodeImpl} to
 * provide node logic; subclasses inherit the schema/retry/timeout machinery of
 * {@link BaseNode}, and the parallel-worker fan-out of this class.
 *
 * Named `WorkflowNode` (not `Node`) to read consistently with `Workflow` and
 * `WorkflowConfig`, and to avoid shadowing the DOM / `@types/node` `Node`
 * global in the flat `@google/adk` namespace. The `node()` factory remains the
 * ergonomic way to wrap a function/tool/agent.
 *
 * Mirrors `google/adk-python` `workflow/_node.py::Node`.
 */
@experimental
export abstract class WorkflowNode<
  TInput = unknown,
  TOutput = unknown,
> extends BaseNode<TInput, TOutput> {
  /** Brand identifying this object as a {@link WorkflowNode}. */
  readonly [WORKFLOW_NODE_SIGNATURE_SYMBOL] = true;

  /** Whether this node fans itself out over the items of a list input. */
  readonly parallelWorker: boolean;

  /** Concurrency limit for the fan-out, or `undefined` for the default. */
  readonly maxParallelWorkers?: number;

  private worker?: BaseNode;

  constructor(config: WorkflowNodeConfig) {
    assertParallelWorkerOptions(config);
    super(config);
    this.parallelWorker = config.parallelWorker ?? false;
    this.maxParallelWorkers = config.maxParallelWorkers;
    this.rebuildParallelWorker();
  }

  /**
   * Discards the fan-out wrapper, so the next run builds a fresh one around
   * this node, and restores the `rerunOnResume` a parallel worker forces.
   *
   * Called on a node that has just been shallow-copied — by `node(existing,
   * {...})` and by {@link clone} — whose wrapper would otherwise still fan out
   * over the node it was copied from.
   */
  rebuildParallelWorker(): void {
    this.worker = undefined;
    if (this.parallelWorker) {
      // `ParallelWorker` sets `rerunOnResume` on itself, but the engine reads
      // this node's flag when it schedules the node, before the wrapper exists.
      Object.assign(this, {rerunOnResume: true});
    }
  }

  /**
   * Copies this node, preserving its class and its own fields, and rebuilds the
   * copy's fan-out wrapper. Mirrors `Node.model_copy`.
   *
   * Only the parallel-worker fields can be overridden. The copy is shallow, so
   * replacing a property something else is derived from — `retryConfig`, whose
   * prepared form is computed at construction — would leave the two disagreeing.
   */
  clone(
    overrides: Partial<
      Pick<WorkflowNodeConfig, 'parallelWorker' | 'maxParallelWorkers'>
    > = {},
  ): this {
    const copy = copyNodeWithPrototype(this, overrides);
    copy.rebuildParallelWorker();
    return copy;
  }

  /**
   * Builds the fan-out wrapper: a `ParallelWorker` around a copy of this node
   * with `parallelWorker` off, so the copy's {@link runImpl} dispatches to
   * {@link runNodeImpl} instead of recursing back into the wrapper.
   *
   * Called only when `parallelWorker` is set.
   */
  protected createParallelWorker(): BaseNode {
    return buildNode(this.clone({parallelWorker: false}), {
      parallelWorker: true,
      maxParallelWorkers: this.maxParallelWorkers,
    });
  }

  /**
   * The fan-out wrapper, built on first access.
   *
   * adk-python builds it in `model_post_init`, which pydantic runs once every
   * field is populated. TypeScript has no such hook: a base constructor runs
   * before a subclass assigns its own fields, so a wrapper built there would
   * wrap a copy with every subclass field still undefined.
   */
  private get innerNode(): BaseNode {
    this.worker ??= this.createParallelWorker();
    return this.worker;
  }

  /**
   * Implement node execution logic here. May yield `Event`s, raw values, or
   * `null` (normalized by {@link BaseNode.run}).
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
    yield* this.innerNode.run(ctx, input);
  }
}

/**
 * Type guard for {@link WorkflowNode}.
 *
 * Matches on this module's brand symbol rather than `instanceof`, so it stays
 * correct across package copies (see the brand's doc).
 */
export function isWorkflowNode(value: unknown): value is WorkflowNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    WORKFLOW_NODE_SIGNATURE_SYMBOL in value &&
    value[WORKFLOW_NODE_SIGNATURE_SYMBOL] === true
  );
}
