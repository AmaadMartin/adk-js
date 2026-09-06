/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, createModelContent, PartListUnion} from '@google/genai';
import {createEvent, Event, isEvent} from '../events/event.js';
import {isContent} from '../utils/content_utils.js';
import {validateIdentifierName} from '../utils/identifier_utils.js';
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
  /**
   * Not `readonly`: a node whose description is resolved asynchronously fills
   * it in after construction. A `RemoteA2AAgent` pointed at an agent card URL
   * only learns the remote's description once it has fetched the card, and a
   * parent agent reads this field to build its transfer instruction.
   */
  description: string;
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
    this.name = validateIdentifierName('Node', config.name.trim());
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
   * A validated value is flattened with `toSerializable` so what lands on
   * an `Event` is persistable and survives a resume. A node with no
   * `outputSchema` keeps its output exactly as yielded, matching the
   * reference's `validate_node_data`, which returns the data untouched when no
   * schema is set.
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

/**
 * Returns the static (run-id-free) path of `target` within `root`, or
 * `undefined` when `target` is not reachable from `root`.
 *
 * The path is the chain of node names from `root` down to `target`, joined by
 * `.`, so it identifies a node's position in the tree independently of any
 * particular run. Two nodes sharing a name resolve to different paths, because
 * the match is on identity rather than on the name.
 *
 * Children are discovered from a node's own enumerable properties, so a node
 * held in an array, `Set`, `Map` or plain-object field is traversed as well.
 * Containers are inspected one level deep: a node nested inside a container
 * inside a container is not found, matching the reference implementation.
 *
 * Mirrors `google/adk-python`
 * `workflow/_base_node.py::find_static_node_path`, which joins with `/`; adk-js
 * paths are dot-separated throughout (see `BranchPath`), so this joins with
 * `.`.
 */
export function findStaticNodePath(
  root: BaseNode,
  target: BaseNode,
): string | undefined {
  return collectNodePath(root, target, new Set<BaseNode>())?.join('.');
}

/**
 * Depth-first walk returning the chain of node names from `curr` to `target`.
 *
 * `visited` makes the walk terminate on a cyclic graph, such as a child holding
 * a back-reference to its parent.
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
  for (const value of Object.values(curr)) {
    const childPath = findPathInValue(value, target, visited);
    if (childPath) {
      return [curr.name, ...childPath];
    }
  }
  return undefined;
}

/** Searches one property value: a node itself, or the nodes it holds. */
function findPathInValue(
  value: unknown,
  target: BaseNode,
  visited: Set<BaseNode>,
): string[] | undefined {
  if (isBaseNode(value)) {
    return collectNodePath(value, target, visited);
  }
  for (const item of containerValues(value)) {
    if (isBaseNode(item)) {
      const path = collectNodePath(item, target, visited);
      if (path) {
        return path;
      }
    }
  }
  return undefined;
}

/** The direct members of a container value, or nothing for a non-container. */
function containerValues(value: unknown): Iterable<unknown> {
  if (Array.isArray(value) || value instanceof Set) {
    return value;
  }
  if (value instanceof Map) {
    return value.values();
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value);
  }
  return [];
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

/** An object that knows how to dump itself, the way `JSON.stringify` asks. */
interface JsonSerializable {
  toJSON(): unknown;
}

/**
 * Recursively converts a validated value into plain, persistable data.
 *
 * A schema may hand back something richer than JSON: a `Set`, a `Map`, a
 * `Date`, or a class instance built by `z.instanceof()` or `.transform()`.
 * Such a value survives in memory but not through a session store, so a
 * resumed run would replay an empty object. This flattens it: a `Set` becomes
 * an array, a `Map` becomes a plain object, an object with `toJSON()` is
 * dumped, and any other object becomes a plain object of its own enumerable
 * properties.
 *
 * The conversion never throws: a value it cannot convert is returned as it is.
 *
 * Mirrors `google/adk-python` `workflow/_base_node.py::_to_serializable` (and
 * the equivalent helper in `utils/_schema_utils.py::validate_node_data`), whose
 * job is `BaseModel -> model_dump()`.
 */
export function toSerializable(value: unknown): unknown {
  return convertValue(value, new WeakSet<object>());
}

/**
 * Converts one value, tracking the objects on the current path so a circular
 * structure terminates instead of overflowing the stack.
 */
function convertValue(value: unknown, converting: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (converting.has(value)) {
    return value;
  }
  converting.add(value);
  const converted = convertObject(value, converting);
  converting.delete(value);
  return converted;
}

/** Dispatches an object to the conversion its shape calls for. */
function convertObject(value: object, converting: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => convertValue(item, converting));
  }
  if (value instanceof Set) {
    return [...value].map((item) => convertValue(item, converting));
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value].map(([key, item]) => [
        String(key),
        convertValue(item, converting),
      ]),
    );
  }
  if (hasToJson(value)) {
    return convertDumped(value, converting);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      convertValue(item, converting),
    ]),
  );
}

/** Dumps an object through `toJSON()`, or returns it if the dump fails. */
function convertDumped(
  value: JsonSerializable,
  converting: WeakSet<object>,
): unknown {
  let dumped: unknown;
  try {
    dumped = value.toJSON();
  } catch {
    return value;
  }
  return convertValue(dumped, converting);
}

function hasToJson(value: object): value is JsonSerializable {
  return typeof (value as Partial<JsonSerializable>).toJSON === 'function';
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
