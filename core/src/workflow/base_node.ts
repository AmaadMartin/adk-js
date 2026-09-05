/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, createModelContent, PartListUnion} from '@google/genai';
import {createEvent, Event, isEvent} from '../events/event.js';
import {isIdentifier} from '../utils/identifier_utils.js';
import {parseWithSchema, SchemaLike} from '../utils/schema.js';
import {NodeSchemaValidationError} from './errors.js';
import type {NodeContext} from './node_context.js';
import {isRequestInput} from './request_input.js';
import {
  PreparedRetryConfig,
  prepareRetryConfig,
  RetryConfig,
} from './retry_config.js';
import {createRequestInputEvent} from './utils/hitl_utils.js';

/**
 * A unique symbol branding {@link BaseNode} instances.
 *
 * Guards match on this brand rather than `instanceof` so a node stays
 * recognisable when it crosses a package boundary (two copies of adk-js in one
 * runtime would fail an `instanceof` check between them) — mirroring the
 * `Symbol.for('google.adk.*')` brands used across ADK (`isBaseAgent`,
 * `isBaseTool`, `isEvent`).
 */
const BASE_NODE_SIGNATURE_SYMBOL = Symbol.for('google.adk.workflow.baseNode');

/**
 * Configuration shared by all workflow nodes.
 *
 * Mirrors the fields of `google/adk-python` `workflow/_base_node.py::BaseNode`.
 */
export interface BaseNodeConfig {
  /** Canonical, unique-within-a-graph node name. */
  name: string;

  /** Human-readable description (used when a node is exposed as a tool). */
  description?: string;

  /**
   * If true, the node re-executes when a workflow resumes even if it already
   * completed in a prior turn. Default false.
   */
  rerunOnResume?: boolean;

  /**
   * If true, the node only produces its output once all of its predecessors
   * have triggered it (fan-in / join semantics). Default false.
   */
  waitForOutput?: boolean;

  /** Optional retry configuration for transient failures. */
  retryConfig?: RetryConfig;

  /** Maximum time, in seconds, for this node to complete. */
  timeout?: number;

  /** Optional schema validating the node input (Zod v3/v4 or genai `Schema`). */
  inputSchema?: SchemaLike;

  /** Optional schema validating the node output (Zod v3/v4 or genai `Schema`). */
  outputSchema?: SchemaLike;

  /** Optional schema validating relevant session state (Zod v3/v4 or genai `Schema`). */
  stateSchema?: SchemaLike;

  /**
   * Runs this node's subtree in an isolated conversation scope: an agent inside
   * it sees only session events carrying the same scope, plus untagged ones.
   * `true` derives a scope per node run; a string is an explicit shared tag.
   */
  isolationScope?: string | true;
}

/**
 * Abstract base class for all nodes in an ADK workflow.
 *
 * A node is a discrete unit of execution. Subclasses implement {@link runImpl},
 * which may yield {@link Event}s, raw values (boxed into an event), or
 * `null`/`undefined` (skipped). {@link run} normalizes those into a stream of
 * {@link Event}s consumed by the engine.
 */
export abstract class BaseNode<TInput = unknown, TOutput = unknown> {
  /** Brand identifying this object as a {@link BaseNode} (see `isBaseNode`). */
  readonly [BASE_NODE_SIGNATURE_SYMBOL] = true;

  readonly name: string;
  readonly description: string;
  readonly rerunOnResume: boolean;
  readonly waitForOutput: boolean;
  readonly retryConfig?: RetryConfig;
  /**
   * The retry config with its exception filter normalized once, up front (see
   * {@link prepareRetryConfig}). Used by the node runner so the retry hot path
   * never re-normalizes or throws on a malformed config mid-retry.
   */
  readonly preparedRetryConfig?: PreparedRetryConfig;
  readonly timeout?: number;
  readonly inputSchema?: SchemaLike;
  readonly outputSchema?: SchemaLike;
  readonly stateSchema?: SchemaLike;
  readonly isolationScope?: string | true;

  constructor(config: BaseNodeConfig) {
    if (
      !config.name ||
      typeof config.name !== 'string' ||
      config.name.trim().length === 0
    ) {
      throw new Error('Node name must be a non-empty string.');
    }
    this.name = config.name.trim();
    if (!isIdentifier(this.name)) {
      throw new Error(
        `Found invalid node name: "${this.name}". Node name must be a valid identifier. It should start with a letter (a-z, A-Z) or an underscore (_), and can only contain letters, digits (0-9), underscores, and hyphens.`,
      );
    }
    this.description = config.description ?? '';
    this.rerunOnResume = config.rerunOnResume ?? false;
    this.waitForOutput = config.waitForOutput ?? false;
    this.retryConfig = config.retryConfig;
    this.preparedRetryConfig = config.retryConfig
      ? prepareRetryConfig(config.retryConfig)
      : undefined;
    this.timeout = config.timeout;
    this.inputSchema = config.inputSchema;
    this.outputSchema = config.outputSchema;
    this.stateSchema = config.stateSchema;
    this.isolationScope = config.isolationScope;
  }

  /**
   * Whether this node must wait for ALL of its predecessors to trigger before
   * it runs (fan-in barrier). Overridden by `JoinNode`.
   */
  get requiresAllPredecessors(): boolean {
    return false;
  }

  /**
   * Core execution contract. Subclasses yield one of:
   *  - an {@link Event} (emitted as-is),
   *  - a raw value (boxed into an event whose `output` is that value),
   *  - `null`/`undefined` (skipped).
   */
  protected abstract runImpl(
    ctx: NodeContext,
    input: TInput,
  ): AsyncGenerator<Event | TOutput | unknown, void, void>;

  /**
   * Runs the node, normalizing every yielded item into an {@link Event}. This
   * is what the engine (and `ctx.runNode()`) consumes. Validates the input
   * against `inputSchema` once, up front (skipping genai `Content`, which nodes
   * coerce themselves).
   */
  async *run(
    ctx: NodeContext,
    input: TInput,
  ): AsyncGenerator<Event, void, void> {
    const validatedInput = this.validateInput(input);
    for await (const item of this.runImpl(ctx, validatedInput)) {
      if (isRequestInput(item)) {
        // HITL: convert a request-for-input into an interrupt event.
        yield createRequestInputEvent(item);
        continue;
      }
      const event = this.toEvent(ctx, item);
      if (event) {
        yield event;
      }
    }
  }

  /**
   * Validates node input against `inputSchema` (Content passes through). Only
   * enforced for Zod schemas; a genai `Schema` is left unvalidated (see
   * `parseWithSchema`).
   */
  protected validateInput(input: TInput): TInput {
    if (isContent(input)) {
      return input;
    }
    try {
      return parseWithSchema(this.inputSchema, input);
    } catch (e) {
      throw new NodeSchemaValidationError({
        nodeName: this.name,
        direction: 'input',
        cause: e,
      });
    }
  }

  /**
   * Validates node output against `outputSchema` (Content passes through). Only
   * enforced for Zod schemas; a genai `Schema` is left unvalidated (see
   * `parseWithSchema`).
   *
   * A validated output is flattened with {@link toSerializable} so a value the
   * schema produced — a `Date`, a `Set`, a class instance a `.transform()`
   * built — survives the session store. With no schema the output is returned
   * untouched, mirroring adk-python's `validate_node_data`.
   */
  protected validateOutput(output: unknown): unknown {
    if (isContent(output)) {
      return output;
    }
    if (this.outputSchema === undefined) {
      return output;
    }
    try {
      return toSerializable(parseWithSchema(this.outputSchema, output));
    } catch (e) {
      throw new NodeSchemaValidationError({
        nodeName: this.name,
        direction: 'output',
        cause: e,
      });
    }
  }

  /**
   * Normalizes a single yielded item into an {@link Event} (or `null` to skip).
   * Subclasses may override for richer coercion (e.g. `FunctionNode`).
   */
  protected toEvent(ctx: NodeContext, data: unknown): Event | null {
    if (data === null || data === undefined) {
      return null;
    }
    if (isEvent(data)) {
      const event = data as Event;
      if (event.output !== undefined) {
        event.output = this.validateOutput(event.output);
      }
      return event;
    }
    const output = this.validateOutput(data);
    return createEvent({
      author: this.name,
      invocationId: ctx.invocationContext.invocationId,
      branch: ctx.branch,
      content: toContent(output),
      output,
    });
  }
}

/**
 * Type guard for {@link BaseNode}.
 *
 * Matches on the {@link BASE_NODE_SIGNATURE_SYMBOL} brand rather than
 * `instanceof` so it stays correct across package copies (see the brand's doc).
 */
export function isBaseNode(value: unknown): value is BaseNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    BASE_NODE_SIGNATURE_SYMBOL in value &&
    value[BASE_NODE_SIGNATURE_SYMBOL] === true
  );
}

/** Returns whether a value looks like a genai `Content` object. */
export function isContent(value: unknown): value is Content {
  return (
    typeof value === 'object' &&
    value !== null &&
    'parts' in value &&
    Array.isArray((value as {parts?: unknown}).parts)
  );
}

/**
 * Returns the static path of `target` within the node tree rooted at `root`,
 * or `undefined` when `target` is not reachable from it.
 *
 * The path is the chain of node names from `root` down to `target` inclusive,
 * carrying no run ids, so it names a node's position in the tree independently
 * of any run. Two nodes sharing a name are told apart by their parents.
 *
 * The segments are joined with `.`, where `google/adk-python`
 * `workflow/_base_node.py::find_static_node_path` joins with `/`. Every path
 * adk-js emits is dot-separated (see `BranchPath` and the node runner's
 * `nodePath`), and a `/`-joined path would not compare against them.
 *
 * Children are found through the node's own enumerable properties, one
 * container level deep, so a node reachable only through a wrapper object —
 * a `Workflow`'s graph, for instance — is not found. The reference has the
 * same blind spot.
 */
export function findStaticNodePath(
  root: BaseNode,
  target: BaseNode,
): string | undefined {
  return collectNodePath(root, target, new Set<BaseNode>())?.join('.');
}

/**
 * Depth-first search for `target` under `curr`, returning the node names along
 * the way. `visited` keeps a cyclic graph terminating.
 */
function collectNodePath(
  curr: BaseNode,
  target: BaseNode,
  visited: Set<BaseNode>,
): string[] | undefined {
  if (visited.has(curr)) {
    return undefined;
  }
  visited.add(curr);
  if (curr === target) {
    return [curr.name];
  }
  const values: unknown[] = Object.values(curr);
  for (const value of values) {
    for (const child of directChildNodes(value)) {
      const path = collectNodePath(child, target, visited);
      if (path) {
        return [curr.name, ...path];
      }
    }
  }
  return undefined;
}

/**
 * Returns the nodes `value` holds directly: `value` itself when it is a node,
 * or the nodes inside one array, `Set`, `Map` or plain object. Nested
 * containers are not descended into.
 */
function directChildNodes(value: unknown): BaseNode[] {
  if (isBaseNode(value)) {
    return [value];
  }
  if (Array.isArray(value) || value instanceof Set) {
    const items: unknown[] = [...value];
    return items.filter(isBaseNode);
  }
  if (value instanceof Map) {
    const items: unknown[] = [...value.values()];
    return items.filter(isBaseNode);
  }
  if (isPlainRecord(value)) {
    const items: unknown[] = Object.values(value);
    return items.filter(isBaseNode);
  }
  return [];
}

/**
 * Flattens a validated node output into plain, persistable data.
 *
 * A `Set` becomes an array, a `Map` and a class instance become plain objects,
 * and a value carrying `toJSON()` — a `Date`, for one — is dumped through it.
 * Arrays and plain objects are walked recursively. A value that needs no
 * conversion is returned by identity, so an already-plain output reaches its
 * `Event` as the very same object.
 *
 * Mirrors `google/adk-python` `workflow/_base_node.py::_to_serializable`, which
 * dumps a Pydantic model and recurses through lists and dicts. It never throws:
 * a value it cannot flatten is returned unchanged, and a circular structure
 * terminates at the point the cycle closes.
 */
export function toSerializable(value: unknown): unknown {
  return flatten(value, new Set<object>());
}

/**
 * Flattens one value. `active` holds the objects on the current recursion path,
 * so re-entering one hands back the original reference instead of looping.
 */
function flatten(value: unknown, active: Set<object>): unknown {
  if (value === null || typeof value !== 'object' || active.has(value)) {
    return value;
  }
  active.add(value);
  let flattened: unknown;
  try {
    flattened = flattenObject(value, active);
  } catch {
    flattened = value;
  }
  active.delete(value);
  return flattened;
}

/** Flattens a non-null object by container kind. */
function flattenObject(value: object, active: Set<object>): unknown {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return flattenList(items, active) ?? value;
  }
  if (value instanceof Set) {
    const items: unknown[] = [...value];
    return flattenList(items, active) ?? items;
  }
  if (value instanceof Map) {
    const record: Record<string, unknown> = {};
    for (const [key, item] of value) {
      record[String(key)] = item;
    }
    return flattenRecord(record, active) ?? record;
  }
  if (hasToJson(value)) {
    return flatten(value.toJSON(), active);
  }
  if (isPlainRecord(value)) {
    return flattenRecord(value, active) ?? value;
  }
  return flattenRecord(value, active) ?? {...value};
}

/**
 * Flattens every item, or returns `undefined` when each one was already plain.
 * That is the caller's signal to hand back the original container.
 */
function flattenList(
  items: unknown[],
  active: Set<object>,
): unknown[] | undefined {
  let changed = false;
  const flattened = items.map((item) => {
    const flat = flatten(item, active);
    changed ||= flat !== item;
    return flat;
  });
  return changed ? flattened : undefined;
}

/** The `flattenList` contract, over an object's own enumerable values. */
function flattenRecord(
  source: object,
  active: Set<object>,
): Record<string, unknown> | undefined {
  let changed = false;
  const flattened: Record<string, unknown> = {};
  const entries: Array<[string, unknown]> = Object.entries(source);
  for (const [key, value] of entries) {
    const flat = flatten(value, active);
    changed ||= flat !== value;
    flattened[key] = flat;
  }
  return changed ? flattened : undefined;
}

/** Returns whether `value` carries a callable `toJSON()`. */
function hasToJson(value: object): value is {toJSON(): unknown} {
  return (
    'toJSON' in value &&
    typeof (value as {toJSON: unknown}).toJSON === 'function'
  );
}

/**
 * Returns whether `value` is a plain object literal rather than a class
 * instance — the counterpart of the reference's `dict` branch.
 *
 * `workflow/utils/workflow_graph_utils.ts` carries the same predicate, but that
 * module imports this one; importing it back would read `START` before it is
 * constructed.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The sentinel node marking the entry point of a workflow graph. It is never
 * executed — the orchestrator seeds triggers for its successors directly.
 *
 * Mirrors `google/adk-python` `START = BaseNode(name='__START__')`.
 */
class StartNode extends BaseNode {
  // eslint-disable-next-line require-yield
  protected async *runImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('START node is never executed.');
  }
}

/** The workflow entry-point sentinel node (name `__START__`). */
export const START: BaseNode = new StartNode({name: '__START__'});

/**
 * Best-effort conversion of an arbitrary value to genai `Content` for display.
 *
 * Strings, `Part`s, and arrays of them are converted via `createModelContent`.
 * Any other value (a plain object, number, boolean, …) is not a valid genai
 * part list, so it is serialized to text rather than throwing.
 */
export function toContent(val: unknown): Content | undefined {
  if (val === null || val === undefined) {
    return undefined;
  }

  if (isContent(val)) {
    return val;
  }

  try {
    return createModelContent(val as PartListUnion);
  } catch {
    return createModelContent(valueToText(val));
  }
}

/** Serializes an arbitrary value to a text string for display. */
function valueToText(val: unknown): string {
  if (typeof val === 'string') {
    return val;
  }
  try {
    // JSON.stringify returns undefined for functions/symbols; fall back to
    // String() there (and for non-serializable values like circular refs).
    return JSON.stringify(val) ?? String(val);
  } catch {
    return String(val);
  }
}
