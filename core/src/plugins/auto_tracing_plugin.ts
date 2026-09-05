/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Instruments the functions an agent can reach so that each call emits an
 * OpenTelemetry span.
 *
 * Ported from adk-python `src/google/adk/plugins/auto_tracing_plugin.py`.
 */

import {Content} from '@google/genai';
import {trace, type Tracer} from '@opentelemetry/api';

import {InvocationContext} from '../agents/invocation_context.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {version} from '../version.js';
import {
  buildTracingWrapper,
  createCaps,
  isClassConstructor,
  isMap,
  isSet,
  isTraced,
  isTracedFunction,
  tracerWillRecord,
  typeLabel,
  type Caps,
  type TracedFunction,
} from './auto_tracing_helpers.js';
import {BasePlugin} from './base_plugin.js';

/** Default bound on how deep the plugin walks from the agent. */
export const DEFAULT_MAX_WALK_DEPTH = 30;

/**
 * Bound on how many objects one pass visits.
 *
 * A JavaScript object graph reachable from an agent is far larger than the
 * set of module names the reference walks, and an unbounded walk over it
 * would be a leak in a long-running process.
 */
const MAX_WALK_NODES = 10_000;

/**
 * Every prototype the runtime itself owns, which the walk stops at.
 *
 * Derived rather than listed, because a hand-written list is silently
 * incomplete and an omission is not a missing feature: it is a wrapped
 * `Promise.prototype.then` or `URL.prototype.toJSON`, which changes the
 * behaviour of every value in the process. The globals are read through their
 * property descriptors, so building the set fires no deprecation getter.
 */
function intrinsicPrototypes(): ReadonlySet<object> {
  const found = new Set<object>();
  const addChain = (start: unknown): void => {
    let current: unknown = start;
    while (typeof current === 'object' && current !== null) {
      found.add(current);
      current = Object.getPrototypeOf(current);
    }
  };
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    const global: unknown = Object.getOwnPropertyDescriptor(
      globalThis,
      key,
    )?.value;
    if (typeof global !== 'function') {
      continue;
    }
    addChain(Object.getOwnPropertyDescriptor(global, 'prototype')?.value);
  }
  // No global names the iterator and generator prototypes, so they are
  // reached through an instance instead.
  function* generator(): Generator<never> {}
  async function* asyncGenerator(): AsyncGenerator<never> {}
  addChain(Object.getPrototypeOf(Object.getPrototypeOf(generator())));
  addChain(Object.getPrototypeOf(Object.getPrototypeOf(asyncGenerator())));
  return found;
}

const INTRINSIC_PROTOTYPES: ReadonlySet<object> = intrinsicPrototypes();

/** Options for {@link AutoTracingPlugin}. */
export interface AutoTracingPluginOptions {
  /** Plugin name, as reported to the runner. */
  name?: string;
  /** Tracer the spans are opened on. Defaults to the ADK tracer. */
  tracer?: Tracer;
  /** Extra objects to instrument that the agent graph does not reach. */
  extraTargets?: readonly object[];
  /** Maximum length of a rendered value written to a span attribute. */
  maxReprLen?: number;
  /** Maximum number of a generator's yields sampled into a span attribute. */
  maxRecordedYields?: number;
  /** Maximum depth the walk descends from each root. */
  maxWalkDepth?: number;
}

/** Bounds carried through one instrumentation pass. */
interface WalkState {
  readonly seen: Set<object>;
  nodes: number;
}

/**
 * The own, string-keyed data properties of `owner`.
 *
 * Accessor properties are left out, so a getter never fires during the walk.
 * Names starting with `_` are left out too, matching the reference, which
 * reads only public instance state.
 */
function ownValueEntries(owner: object): Array<[string, PropertyDescriptor]> {
  return Object.entries(Object.getOwnPropertyDescriptors(owner)).filter(
    ([key, descriptor]) => !key.startsWith('_') && 'value' in descriptor,
  );
}

/** The class name to prefix a prototype's method spans with. */
function prototypeOwnerName(prototype: object): string | undefined {
  const constructor: unknown = Object.getOwnPropertyDescriptor(
    prototype,
    'constructor',
  )?.value;
  if (typeof constructor === 'function' && constructor.name.length > 0) {
    return constructor.name;
  }
  return undefined;
}

/**
 * Wraps the functions an agent can reach so that calling one emits a span.
 *
 * Add the plugin to an app and every function reachable from the running
 * agent starts recording its arguments, its return value or its error, with
 * credentials masked. The span names are `Owner.method` for a method and the
 * function's own name for a standalone function.
 *
 * The plugin **mutates the objects and prototypes it reaches**, process-wide
 * and for the life of the process. That is what instrumentation is, and it is
 * what the reference implementation does, but it means a class the agent
 * reaches stays wrapped for every other user of that class too.
 *
 * The pass runs on `beforeRunCallback` and is idempotent: a function already
 * carrying the wrapped marker is left alone.
 *
 * Example:
 * ```typescript
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
  private readonly maxWalkDepth: number;
  private readonly extraTargets: readonly object[];
  /** Computed once: a tracer that will not record makes the pass pointless. */
  private readonly tracerEligible: boolean;

  constructor(options: AutoTracingPluginOptions = {}) {
    super(options.name ?? 'AutoTracingPlugin');
    this.tracer =
      options.tracer ?? trace.getTracer('gcp.vertex.agent', version);
    this.caps = createCaps({
      maxReprLen: options.maxReprLen,
      maxRecordedYields: options.maxRecordedYields,
    });
    this.maxWalkDepth = options.maxWalkDepth ?? DEFAULT_MAX_WALK_DEPTH;
    this.extraTargets = options.extraTargets ?? [];
    this.tracerEligible = tracerWillRecord(this.tracer);
  }

  override async beforeRunCallback(params: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    if (!this.tracerEligible) {
      return;
    }
    const state: WalkState = {seen: new Set<object>(), nodes: MAX_WALK_NODES};
    this.walk(params.invocationContext?.agent, 0, state);
    for (const target of this.extraTargets) {
      this.walk(target, 0, state);
    }
    return;
  }

  private walk(value: unknown, depth: number, state: WalkState): void {
    if (depth > this.maxWalkDepth) {
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }
    if (state.seen.has(value) || state.nodes <= 0) {
      return;
    }
    state.nodes -= 1;
    state.seen.add(value);
    try {
      this.visit(value, depth, state);
    } catch (error: unknown) {
      logger.debug(
        `AutoTracingPlugin: skipped ${typeLabel(value)}: ${formatError(error)}`,
      );
    }
  }

  private visit(value: object, depth: number, state: WalkState): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        this.walk(item, depth + 1, state);
      }
      return;
    }
    if (isMap(value)) {
      for (const item of value.values()) {
        this.walk(item, depth + 1, state);
      }
      return;
    }
    if (isSet(value)) {
      for (const item of value) {
        this.walk(item, depth + 1, state);
      }
      return;
    }
    for (const [key, descriptor] of ownValueEntries(value)) {
      const held: unknown = descriptor.value;
      if (isTracedFunction(held)) {
        this.wrap({owner: value, key, descriptor, fn: held});
      } else {
        this.walk(held, depth + 1, state);
      }
    }
    this.instrumentPrototypeChain(value);
  }

  private instrumentPrototypeChain(value: object): void {
    let prototype: unknown = Object.getPrototypeOf(value);
    while (
      typeof prototype === 'object' &&
      prototype !== null &&
      !INTRINSIC_PROTOTYPES.has(prototype)
    ) {
      this.instrumentPrototype(prototype);
      prototype = Object.getPrototypeOf(prototype);
    }
  }

  private instrumentPrototype(prototype: object): void {
    const ownerName = prototypeOwnerName(prototype);
    for (const [key, descriptor] of ownValueEntries(prototype)) {
      const held: unknown = descriptor.value;
      if (key !== 'constructor' && isTracedFunction(held)) {
        this.wrap({owner: prototype, key, descriptor, fn: held, ownerName});
      }
    }
  }

  private wrap(params: {
    owner: object;
    key: string;
    descriptor: PropertyDescriptor;
    fn: TracedFunction;
    ownerName?: string;
  }): void {
    const {owner, key, descriptor, fn, ownerName} = params;
    if (isTraced(fn) || isClassConstructor(fn)) {
      return;
    }
    if (descriptor.writable !== true || descriptor.configurable !== true) {
      logger.debug(
        `AutoTracingPlugin: cannot rebind ${key}, it is not writable`,
      );
      return;
    }
    try {
      Object.defineProperty(owner, key, {
        ...descriptor,
        value: buildTracingWrapper({
          fn,
          tracer: this.tracer,
          caps: this.caps,
          ownerName,
        }),
      });
    } catch (error: unknown) {
      logger.debug(
        `AutoTracingPlugin: cannot rebind ${key}: ${formatError(error)}`,
      );
    }
  }
}
