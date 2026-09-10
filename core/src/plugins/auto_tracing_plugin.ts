/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Auto-instruments the functions an agent can reach so that every call emits
 * an OpenTelemetry span carrying its arguments and its result.
 *
 * Ported from `google/adk-python`
 * `src/google/adk/plugins/auto_tracing_plugin.py`.
 */

import {trace, Tracer} from '@opentelemetry/api';
import {InvocationContext} from '../agents/invocation_context.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {
  buildTracingWrapper,
  CALLABLE_SHAPE_SAMPLES,
  Caps,
  DEFAULT_MAX_RECORDED_YIELDS,
  DEFAULT_MAX_REPR_LEN,
  isClassConstructor,
  isMap,
  isPublicName,
  isSet,
  isTracedFunction,
  isTracingWrapper,
  TracedFunction,
  tracerWillRecord,
  typeNameOf,
} from './auto_tracing_helpers.js';
import {BasePlugin} from './base_plugin.js';

/** Default limit on how deep the plugin follows references from the agent. */
export const DEFAULT_MAX_WALK_DEPTH = 30;

/**
 * Limit on how many objects one pass may visit.
 *
 * The reference bounds its walk by depth and identity alone, because it only
 * collects a small set of module names. A JavaScript object graph reachable
 * from an agent is far larger, and an unbounded walk inside a long-running
 * process is a leak.
 */
const MAX_WALK_NODES = 10000;

/** Property name that holds a prototype's own class, never instrumented. */
const CONSTRUCTOR_KEY = 'constructor';

/**
 * Instrumentation scope used when the caller supplies no tracer.
 *
 * A scope of the plugin's own, so these spans are distinguishable from the
 * framework spans ADK emits on `gcp.vertex.agent`. The reference makes the
 * same choice with `trace.get_tracer(__name__)`.
 */
const DEFAULT_TRACER_NAME = 'gcp.vertex.agent.auto_tracing';

/** Bounds carried through one instrumentation pass. */
interface WalkState {
  /** Objects already visited, so a cycle terminates. */
  readonly seen: Set<object>;
  /** Remaining objects the pass may visit. */
  budget: number;
}

/** Adds `value` and every prototype above it to `target`. */
function addPrototypeChain(target: Set<object>, value: unknown): void {
  let current: unknown = value;
  while (
    current !== null &&
    (typeof current === 'object' || typeof current === 'function')
  ) {
    if (target.has(current)) {
      return;
    }
    target.add(current);
    current = Object.getPrototypeOf(current) as unknown;
  }
}

/**
 * Collects every object that belongs to the JavaScript runtime rather than to
 * the application.
 *
 * Wrapping `Promise.prototype.then` or `Array.prototype.map` would change the
 * behaviour of every value in the process, so the set is derived rather than
 * hand-listed: an omission from a hand-written list is not a missing feature,
 * it is a corrupted runtime. Globals are read through their property
 * descriptors so that a deprecation getter never fires.
 */
function collectIntrinsicObjects(): ReadonlySet<object> {
  const found = new Set<object>();
  addPrototypeChain(found, globalThis);
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    if (!descriptor || !('value' in descriptor)) {
      continue;
    }
    const value: unknown = descriptor.value;
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function')
    ) {
      continue;
    }
    addPrototypeChain(found, value);
    addPrototypeChain(found, (value as {prototype?: unknown}).prototype);
  }
  // Generator and async generator prototypes have no global binding, so they
  // are reached through the shape samples instead.
  for (const sample of CALLABLE_SHAPE_SAMPLES) {
    addPrototypeChain(found, sample);
    addPrototypeChain(found, sample.prototype);
  }
  return found;
}

const INTRINSIC_OBJECTS = collectIntrinsicObjects();

/** Returns the class name a prototype belongs to, when it declares one. */
function constructorNameOf(prototype: object): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(
    prototype,
    CONSTRUCTOR_KEY,
  );
  const value: unknown = descriptor?.value;
  return typeof value === 'function' && value.name ? value.name : undefined;
}

/** Options accepted by {@link AutoTracingPlugin}. */
export interface AutoTracingPluginOptions {
  /** Plugin instance identifier. Defaults to `AutoTracingPlugin`. */
  name?: string;
  /**
   * Tracer the wrappers emit spans on. Defaults to a tracer on the
   * `gcp.vertex.agent.auto_tracing` scope.
   */
  tracer?: Tracer;
  /**
   * Extra objects to instrument, for functions the agent graph does not
   * reach.
   */
  extraTargets?: readonly object[];
  /** Maximum length of one rendered value. Defaults to `4096`. */
  maxReprLen?: number;
  /** Maximum yields sampled from one generator call. Defaults to `16`. */
  maxRecordedYields?: number;
  /** Maximum reference depth followed from the agent. Defaults to `30`. */
  maxWalkDepth?: number;
}

/**
 * Emits an OpenTelemetry span for every public function an agent can reach.
 *
 * Add it to an `App` and each reached function is replaced by a wrapper that
 * opens a span named after the function -- `Owner.method` for a method on a
 * class prototype, the bare name otherwise -- records the call's arguments as
 * `adk.fn.arg.*`, and records the result as `adk.fn.return` or the failure as
 * `adk.fn.exc_type` and `adk.fn.exc_repr`. Arguments and fields whose names
 * mark them as credentials are dropped or masked before anything is written.
 *
 * **This plugin mutates the objects and prototypes it reaches, process-wide,
 * for the life of the process.** A class the agent reaches stays wrapped for
 * every other user of that class, and there is no way to undo it. That is
 * what instrumentation is, and it is what the reference implementation does,
 * but it makes the plugin unsuitable for a process that also serves
 * uninstrumented work.
 *
 * @example
 * ```ts
 * const app = new App({
 *   name: 'auto_tracing',
 *   rootAgent: agent,
 *   plugins: [new AutoTracingPlugin()],
 * });
 * ```
 */
export class AutoTracingPlugin extends BasePlugin {
  private readonly tracer: Tracer;
  private readonly caps: Caps;
  private readonly extraTargets: readonly object[];
  private readonly maxWalkDepth: number;
  private readonly tracerEligible: boolean;

  constructor(options: AutoTracingPluginOptions = {}) {
    super(options.name ?? 'AutoTracingPlugin');
    this.tracer = options.tracer ?? trace.getTracer(DEFAULT_TRACER_NAME);
    this.caps = {
      maxReprLen: options.maxReprLen ?? DEFAULT_MAX_REPR_LEN,
      maxRecordedYields:
        options.maxRecordedYields ?? DEFAULT_MAX_RECORDED_YIELDS,
    };
    this.extraTargets = options.extraTargets ?? [];
    this.maxWalkDepth = options.maxWalkDepth ?? DEFAULT_MAX_WALK_DEPTH;
    this.tracerEligible = tracerWillRecord(this.tracer);
  }

  /**
   * Instruments everything reachable from the invocation's agent and from
   * `extraTargets`.
   *
   * The pass is idempotent: a function that already carries a wrapper is left
   * alone, so a second invocation changes nothing. The reference guards this
   * with a lock; the pass here is synchronous from start to finish, so no
   * other callback can interleave with it.
   */
  override async beforeRunCallback(params: {
    invocationContext: InvocationContext;
  }): Promise<undefined> {
    if (!this.tracerEligible) {
      return;
    }
    const state: WalkState = {seen: new Set<object>(), budget: MAX_WALK_NODES};
    this.walk(params.invocationContext.agent, 0, state);
    for (const target of this.extraTargets) {
      this.walk(target, 0, state);
    }
    return;
  }

  /**
   * Visits one value, instrumenting or descending according to its shape.
   *
   * A value that fights back -- a proxy that throws from a trap, an exotic
   * object that rejects reflection -- is logged and skipped, so one hostile
   * node cannot abort the whole pass. The reference does the same for a
   * module it fails to instrument.
   */
  private walk(value: unknown, depth: number, state: WalkState): void {
    if (
      depth > this.maxWalkDepth ||
      value === null ||
      typeof value !== 'object'
    ) {
      return;
    }
    if (state.seen.has(value) || INTRINSIC_OBJECTS.has(value)) {
      return;
    }
    state.seen.add(value);
    if (state.budget-- <= 0) {
      return;
    }
    try {
      this.visit(value, depth, state);
    } catch (error) {
      logger.warn(
        `AutoTracingPlugin: failed to instrument ${typeNameOf(value)}:` +
          ` ${formatError(error)}`,
      );
    }
  }

  /** Descends into a container, or instruments an ordinary object. */
  private visit(node: object, depth: number, state: WalkState): void {
    const members = memberValuesOf(node);
    if (members) {
      for (const member of members) {
        this.walk(member, depth + 1, state);
      }
      return;
    }
    this.instrumentOwnProperties(node, depth, state);
    this.instrumentPrototypeChain(node, state);
  }

  /**
   * Wraps the object's own public function properties and descends into the
   * rest.
   *
   * Properties are read through their descriptors so that a getter or a lazy
   * descriptor never fires during the pass.
   */
  private instrumentOwnProperties(
    node: object,
    depth: number,
    state: WalkState,
  ): void {
    for (const key of Object.keys(node)) {
      if (!isPublicName(key) || key === CONSTRUCTOR_KEY) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !('value' in descriptor)) {
        continue;
      }
      const value: unknown = descriptor.value;
      if (isTracedFunction(value)) {
        this.rebind(node, key, value, descriptor);
      } else {
        this.walk(value, depth + 1, state);
      }
    }
  }

  /**
   * Wraps the methods declared by the object's class and by its base classes.
   *
   * This is the counterpart of the reference instrumenting the class methods
   * of an in-scope module: in JavaScript those methods live on the prototype
   * chain, not on the instance. The walk stops at the first runtime-owned
   * prototype, so `Object.prototype` and friends are never touched.
   */
  private instrumentPrototypeChain(node: object, state: WalkState): void {
    let prototype = Object.getPrototypeOf(node) as object | null;
    while (
      prototype !== null &&
      !INTRINSIC_OBJECTS.has(prototype) &&
      !state.seen.has(prototype)
    ) {
      state.seen.add(prototype);
      if (state.budget-- <= 0) {
        return;
      }
      this.wrapOwnMethods(prototype);
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
  }

  /** Wraps every public method a prototype declares itself. */
  private wrapOwnMethods(prototype: object): void {
    const ownerName = constructorNameOf(prototype);
    for (const key of Object.getOwnPropertyNames(prototype)) {
      if (!isPublicName(key) || key === CONSTRUCTOR_KEY) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (!descriptor || !('value' in descriptor)) {
        continue;
      }
      const value: unknown = descriptor.value;
      if (isTracedFunction(value)) {
        this.rebind(prototype, key, value, descriptor, ownerName);
      }
    }
  }

  /**
   * Replaces one function property with its tracing wrapper.
   *
   * A frozen object, or a property that is neither writable nor configurable,
   * is the normal case rather than an error: it is logged at debug level and
   * skipped. The original descriptor flags are reused so that a non-enumerable
   * prototype method does not become enumerable.
   */
  private rebind(
    owner: object,
    key: string,
    fn: TracedFunction,
    descriptor: PropertyDescriptor,
    ownerName?: string,
  ): void {
    if (isTracingWrapper(fn) || isClassConstructor(fn)) {
      return;
    }
    try {
      Object.defineProperty(owner, key, {
        ...descriptor,
        value: buildTracingWrapper(fn, this.tracer, this.caps, ownerName),
      });
    } catch (error) {
      logger.debug(
        `AutoTracingPlugin: cannot rebind ${ownerName ?? 'object'}.${key}:` +
          ` ${formatError(error)}`,
      );
    }
  }
}

/**
 * Returns the members a container holds, or `undefined` when the value is not
 * a container. Mirrors the reference recursing into `list`, `tuple`, `set` and
 * `dict` values.
 */
function memberValuesOf(value: object): Iterable<unknown> | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (isMap(value)) {
    return value.values();
  }
  if (isSet(value)) {
    return value;
  }
  return undefined;
}
