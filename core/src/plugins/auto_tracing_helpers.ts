/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers for {@link AutoTracingPlugin}: value rendering with credential
 * masking, span attribute writing, and construction of the tracing wrapper
 * that replaces an instrumented function.
 *
 * Ported from `google/adk-python`
 * `src/google/adk/plugins/auto_tracing_helpers.py`.
 */

import {isSpanContextValid, Span, Tracer} from '@opentelemetry/api';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';

/** Default cap on the length of a single rendered value. */
export const DEFAULT_MAX_REPR_LEN = 4096;

/** Default cap on how many yielded items a wrapped generator records. */
export const DEFAULT_MAX_RECORDED_YIELDS = 16;

/**
 * Marks a function as already wrapped.
 *
 * Registered with `Symbol.for` so that two copies of `@google/adk` loaded in
 * one runtime agree on the marker. A module-local `Symbol()` would miss the
 * other copy's marker and wrap an already-wrapped function a second time.
 */
const WRAPPED_MARKER = Symbol.for('adk.autoTracing.wrapped');

/** Brands {@link StreamResult} across duplicate copies of this package. */
const STREAM_RESULT_BRAND = Symbol.for('adk.autoTracing.streamResult');

/** Property-name prefix that marks a field as internal to its class. */
const PRIVATE_PREFIX = '_';

/** Span created only to ask a tracer whether it records. */
const TRACER_PROBE_SPAN_NAME = 'adk.autoTracing.probe';

/** Span name used when a wrapped function has no name of its own. */
const ANONYMOUS_DISPLAY_NAME = 'anonymous';

/**
 * Type names whose values carry live secrets. Matched by walking the
 * prototype chain, which mirrors the reference walking `cls.__mro__`, so this
 * module never has to import `../auth`.
 *
 * A minifying bundler renames classes and defeats this arm of the check. The
 * argument-name arm below still holds, because parameter names survive
 * minification in the function source this module parses.
 */
const CREDENTIAL_TYPE_NAMES: ReadonlySet<string> = new Set([
  'AuthConfig',
  'AuthCredential',
  'AuthToolArguments',
  'Credentials',
  'HttpAuth',
  'HttpCredentials',
  'OAuth2Auth',
  'OAuth2Session',
  'ServiceAccount',
  'ServiceAccountCredential',
]);

/**
 * Endings that mark a parameter or field name as secret-bearing, lowercased
 * before comparison.
 *
 * The reference keeps two lists, exact names and `_`-prefixed suffixes. One
 * list of suffixes covers both, because a name ends with itself.
 *
 * Both spellings of a two-word term are listed. The reference has only the
 * snake_case ones; adk-js names these parameters `apiKey`, `authConfig`,
 * `authCredential` and `privateKey`, and lowercasing `serviceApiKey` gives
 * `serviceapikey`, which `api_key` does not match. Without the camelCase
 * spellings this module would leak in adk-js exactly the secrets it masks in
 * adk-python.
 */
const CREDENTIAL_ARG_SUFFIXES: readonly string[] = [
  'api_key',
  'apikey',
  'auth_config',
  'authconfig',
  'auth_credential',
  'authcredential',
  'authorization',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'password',
  'private_key',
  'privatekey',
  'secret',
  'token',
];

/**
 * Bounds for the rendering walk. Both are deliberately generous: only
 * containers and objects consume node budget, so an array of a million
 * numbers costs one node.
 */
const MAX_RENDER_DEPTH = 10;
const MAX_RENDER_NODES = 1024;

/** Upper bound on how far {@link isCredentialType} follows a prototype chain. */
const MAX_PROTOTYPE_CHAIN_DEPTH = 100;

/** Matches a name that can be written as a bare object key. */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Matches an arrow function whose single parameter has no parentheses. */
const BARE_ARROW_PARAM_RE = /^\s*(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*=>/;

/** Matches the leading identifier of a parameter declaration. */
const LEADING_IDENTIFIER_RE = /^([A-Za-z_$][A-Za-z0-9_$]*)/;

/** Matches source text that declares a class rather than a callable function. */
const CLASS_SOURCE_RE = /^\s*(?:@[^\s(]+(?:\([^)]*\))?\s*)*class[\s{]/;

/** Rest parameter prefix, which ends the list of named positional parameters. */
const REST_PARAMETER_PREFIX = '...';

/**
 * Any callable this module wraps.
 *
 * The parameter and return types are the widest possible because the module
 * wraps functions it did not declare and cannot know their real signatures.
 * Every argument reaches the wrapped function untouched.
 */
export type TracedFunction = (...args: unknown[]) => unknown;

/** A recorded argument as `[name, renderedValue]`. */
export type NamedArg = readonly [name: string, rendered: string];

/** Bounds on captured value renderings and recorded generator yields. */
export interface Caps {
  /** Maximum length of one rendered value before it is truncated. */
  readonly maxReprLen: number;
  /** Maximum number of yielded items sampled from a wrapped generator. */
  readonly maxRecordedYields: number;
}

/** Mutable bounds carried through one rendering walk. */
interface RenderState {
  /** Remaining container nodes the walk may enter. */
  budget: number;
  /** Objects on the current path, so a cycle is elided rather than followed. */
  readonly active: Set<object>;
}

/** Narrows an arbitrary value to a callable. */
export function isTracedFunction(value: unknown): value is TracedFunction {
  return typeof value === 'function';
}

/** Returns the built-in brand of `value`, for example `[object Map]`. */
function brandOf(value: object): string {
  return Object.prototype.toString.call(value);
}

/** True when `value` is a `Map`, checked by brand so it holds across realms. */
export function isMap(value: object): value is Map<unknown, unknown> {
  return brandOf(value) === '[object Map]';
}

/** True when `value` is a `Set`, checked by brand so it holds across realms. */
export function isSet(value: object): value is Set<unknown> {
  return brandOf(value) === '[object Set]';
}

function isDate(value: object): value is Date {
  return brandOf(value) === '[object Date]';
}

function isRegExp(value: object): value is RegExp {
  return brandOf(value) === '[object RegExp]';
}

function isError(value: object): value is Error {
  return brandOf(value) === '[object Error]';
}

function isStreamResult(value: object): value is StreamResult {
  return STREAM_RESULT_BRAND in value;
}

/** True when `value` is a bare `{...}` rather than a class instance. */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || prototype === Object.prototype;
}

/**
 * Returns the constructor name of `value`, or its `typeof` when it has none.
 * Never throws, so it is safe to call from an error path.
 */
export function typeNameOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  try {
    const constructor = (value as {constructor?: unknown}).constructor;
    if (typeof constructor === 'function' && constructor.name) {
      return constructor.name;
    }
  } catch {
    return typeof value;
  }
  return typeof value;
}

/** True when `value` or one of its prototypes is a credential-bearing type. */
function isCredentialType(value: object): boolean {
  let prototype = Object.getPrototypeOf(value) as object | null;
  for (let depth = 0; prototype !== null; depth++) {
    if (depth >= MAX_PROTOTYPE_CHAIN_DEPTH) {
      return false;
    }
    const constructor = (prototype as {constructor?: unknown}).constructor;
    if (
      typeof constructor === 'function' &&
      CREDENTIAL_TYPE_NAMES.has(constructor.name)
    ) {
      return true;
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return false;
}

/**
 * True when a parameter or field called `name` conventionally holds a secret.
 *
 * Matching is case-insensitive, so `CLIENT_SECRET`, `client_secret` and
 * `clientSecret` are all recognised.
 */
export function isCredentialArgName(name: string): boolean {
  const lowered = name.toLowerCase();
  return CREDENTIAL_ARG_SUFFIXES.some((suffix) => lowered.endsWith(suffix));
}

/**
 * True when a property name is part of a value's public surface. Mirrors the
 * reference's public-only rule, which skips `_`-prefixed names.
 */
export function isPublicName(name: string): boolean {
  return !name.startsWith(PRIVATE_PREFIX);
}

/**
 * A capped sample of the items a wrapped generator yielded, plus the true
 * yield count.
 */
export class StreamResult {
  private readonly [STREAM_RESULT_BRAND] = true;

  constructor(
    private readonly items: readonly unknown[],
    private readonly caps: Caps,
    private readonly total: number,
  ) {}

  /** Renders the sample and the count as a single span attribute value. */
  render(): string {
    if (this.total === 0) {
      return '<generator: 0 items yielded>';
    }
    const sample = this.items.map((item) => safeRepr(item, this.caps));
    const suffix =
      this.total > sample.length
        ? ` ... + ${this.total - sample.length} more`
        : '';
    return (
      `<generator: ${this.total} items yielded; first ${sample.length}:` +
      ` [${sample.join(', ')}]${suffix}>`
    );
  }
}

/** Renders a non-object value, or returns `undefined` when it is an object. */
function renderPrimitive(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
    case 'boolean':
      return String(value);
    case 'bigint':
      return `${value}n`;
    case 'symbol':
      return value.toString();
    case 'undefined':
      return 'undefined';
    case 'function':
      return value.name
        ? `[Function: ${value.name}]`
        : '[Function (anonymous)]';
    default:
      return value === null ? 'null' : undefined;
  }
}

/** Renders an object key, quoting it when it is not a bare identifier. */
function renderKey(key: string): string {
  return IDENTIFIER_RE.test(key) ? key : JSON.stringify(key);
}

/**
 * Renders a member of a container, masking it when its own key marks it as
 * secret material.
 */
function renderMember(
  key: unknown,
  value: unknown,
  depth: number,
  state: RenderState,
): string {
  if (typeof key === 'string' && isCredentialArgName(key)) {
    return `<${typeNameOf(value)}>`;
  }
  return renderNode(value, depth, state);
}

/** Renders an array's elements. */
function renderArray(
  node: readonly unknown[],
  depth: number,
  state: RenderState,
): string {
  const parts: string[] = [];
  for (const item of node) {
    parts.push(renderNode(item, depth, state));
  }
  return `[${parts.join(', ')}]`;
}

/** Renders a `Map`, masking any value whose string key marks it as secret. */
function renderMap(
  node: Map<unknown, unknown>,
  depth: number,
  state: RenderState,
): string {
  const parts: string[] = [];
  for (const [key, value] of node) {
    parts.push(
      `${renderNode(key, depth, state)} => ${renderMember(key, value, depth, state)}`,
    );
  }
  return `Map(${node.size}) {${parts.join(', ')}}`;
}

/** Renders a `Set`'s members. */
function renderSet(
  node: Set<unknown>,
  depth: number,
  state: RenderState,
): string {
  const parts: string[] = [];
  for (const item of node) {
    parts.push(renderNode(item, depth, state));
  }
  return `Set(${node.size}) {${parts.join(', ')}}`;
}

/**
 * Renders a plain object as `{key: value}` and a class instance as
 * `<Name fields={key=value}>`.
 *
 * A class instance shows only its public own fields. The reference walks
 * `_`-prefixed state to find nested credentials but never prints it, so the
 * rendered form can never show more than the value itself would have. This
 * module reaches the same guarantee by never reading private state at all.
 */
function renderObject(node: object, depth: number, state: RenderState): string {
  const plain = isPlainObject(node);
  const separator = plain ? ': ' : '=';
  const parts: string[] = [];
  for (const key of Object.keys(node)) {
    if (!plain && !isPublicName(key)) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (!descriptor || !('value' in descriptor)) {
      continue;
    }
    const value: unknown = descriptor.value;
    parts.push(
      `${renderKey(key)}${separator}${renderMember(key, value, depth, state)}`,
    );
  }
  if (plain) {
    return `{${parts.join(', ')}}`;
  }
  const name = typeNameOf(node);
  return parts.length ? `<${name} fields={${parts.join(', ')}}>` : `<${name}>`;
}

/** Dispatches an object to the renderer for its shape. */
function renderContainer(
  node: object,
  depth: number,
  state: RenderState,
): string {
  if (Array.isArray(node)) {
    return renderArray(node, depth, state);
  }
  if (isMap(node)) {
    return renderMap(node, depth, state);
  }
  if (isSet(node)) {
    return renderSet(node, depth, state);
  }
  if (isDate(node)) {
    return node.toISOString();
  }
  if (isRegExp(node)) {
    return String(node);
  }
  if (isError(node)) {
    return `${typeNameOf(node)}: ${node.message}`;
  }
  return renderObject(node, depth, state);
}

/**
 * Renders one value, masking credentials and eliding anything the walk
 * refuses to enter.
 *
 * A subtree the walk stops at is elided as `<Name ...>` rather than rendered,
 * so reaching a bound can never uncover a secret.
 */
function renderNode(value: unknown, depth: number, state: RenderState): string {
  const primitive = renderPrimitive(value);
  if (primitive !== undefined) {
    return primitive;
  }
  const node = value as object;
  if (isStreamResult(node)) {
    return node.render();
  }
  if (isCredentialType(node)) {
    return `<${typeNameOf(node)}>`;
  }
  state.budget -= 1;
  if (state.budget < 0 || depth >= MAX_RENDER_DEPTH || state.active.has(node)) {
    return `<${typeNameOf(node)} ...>`;
  }
  state.active.add(node);
  try {
    return renderContainer(node, depth + 1, state);
  } finally {
    state.active.delete(node);
  }
}

/** Truncates `text` to `maxLength`, reporting how much was dropped. */
function truncate(text: string, maxLength: number): string {
  return text.length > maxLength
    ? `${text.slice(0, maxLength)}...[${text.length - maxLength} more chars]`
    : text;
}

/**
 * Renders `value` for a span attribute: bounded, credential-masked, and
 * incapable of throwing.
 *
 * A rendering that fails part way elides the value instead of falling back to
 * a plain rendering, because nothing then says the value is free of secrets.
 */
export function safeRepr(value: unknown, caps: Caps): string {
  try {
    const rendered = renderNode(value, 0, {
      budget: MAX_RENDER_NODES,
      active: new Set<object>(),
    });
    return truncate(rendered, caps.maxReprLen);
  } catch (error) {
    logger.warn(
      `AutoTracingPlugin: rendering failed for ${typeNameOf(value)}: ${formatError(error)}`,
    );
    return `<${typeNameOf(value)} ...>`;
  }
}

/** Splits a parameter list on the commas that separate its entries. */
function splitParameters(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const character = list[i];
    if (character === '(' || character === '[' || character === '{') {
      depth++;
    } else if (character === ')' || character === ']' || character === '}') {
      depth--;
    } else if (character === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts;
}

/**
 * Returns the text between a function's outermost parentheses, or `''` when
 * the source declares no parameter list.
 */
function parameterListOf(source: string): string {
  const bareArrow = BARE_ARROW_PARAM_RE.exec(source);
  if (bareArrow) {
    return bareArrow[1];
  }
  const open = source.indexOf('(');
  let depth = 0;
  for (let i = open; i >= 0 && i < source.length; i++) {
    const character = source[i];
    if (character === '(' || character === '[' || character === '{') {
      depth++;
    } else if (character === ')' || character === ']' || character === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(open + 1, i);
      }
    }
  }
  return '';
}

/**
 * Returns the names of a function's positional parameters, in order.
 *
 * Names come from the function source, which is the only place JavaScript
 * keeps them. A destructured parameter contributes an empty name, and a rest
 * parameter ends the list, matching the reference dropping `*args`. Callers
 * fall back to `arg<index>` for an argument with no name.
 *
 * The parser reads brackets, not JavaScript, so a default value containing an
 * unbalanced bracket inside a string literal yields the wrong names. That
 * costs an attribute key, never a call.
 */
export function positionalParamNames(fn: unknown): readonly string[] {
  if (!isTracedFunction(fn)) {
    return [];
  }
  const list = parameterListOf(Function.prototype.toString.call(fn));
  const names: string[] = [];
  for (const part of splitParameters(list)) {
    const declaration = part.trim();
    if (!declaration) {
      break;
    }
    if (declaration.startsWith(REST_PARAMETER_PREFIX)) {
      break;
    }
    names.push(LEADING_IDENTIFIER_RE.exec(declaration)?.[1] ?? '');
  }
  return names;
}

/** True when `fn` is a class declaration, which must never be wrapped. */
export function isClassConstructor(fn: TracedFunction): boolean {
  return CLASS_SOURCE_RE.test(Function.prototype.toString.call(fn));
}

/** True when `fn` already carries a tracing wrapper. */
export function isTracingWrapper(fn: unknown): boolean {
  return isTracedFunction(fn) && WRAPPED_MARKER in fn;
}

/**
 * Returns the span name for `fn`: `Owner.method` when the owner is known, the
 * function's own name otherwise.
 */
export function displayNameFor(fn: TracedFunction, ownerName?: string): string {
  const own = fn.name || ANONYMOUS_DISPLAY_NAME;
  return ownerName ? `${ownerName}.${own}` : own;
}

/**
 * Returns `[name, rendered]` for every argument of a call.
 *
 * An argument whose name marks it as secret material is dropped outright
 * rather than masked: the key alone already says the call took a token, and no
 * rendering of the value is worth recording. Values nested inside a recorded
 * argument are masked in place instead, because dropping them would misreport
 * the shape of the value being traced.
 */
export function nameValuePairs(
  paramNames: readonly string[],
  args: readonly unknown[],
  caps: Caps,
): NamedArg[] {
  const pairs: NamedArg[] = [];
  for (let i = 0; i < args.length; i++) {
    const name = paramNames[i] || `arg${i}`;
    if (isCredentialArgName(name)) {
      continue;
    }
    pairs.push([name, safeRepr(args[i], caps)]);
  }
  return pairs;
}

/**
 * Writes the `adk.fn.*` attributes for one call onto `span`.
 *
 * `error` is `undefined` for a call that returned normally.
 */
export function recordIoOnSpan(
  span: Span,
  pairs: readonly NamedArg[],
  result: unknown,
  error: unknown,
  caps: Caps,
): void {
  for (const [key, value] of pairs) {
    // Repeats the filter in nameValuePairs on purpose: both functions are
    // public, so pairs may come from a caller that never ran that filter.
    if (isCredentialArgName(key)) {
      continue;
    }
    span.setAttribute(`adk.fn.arg.${key}`, value);
  }
  if (error !== undefined) {
    span.setAttribute('adk.fn.exc_type', typeNameOf(error));
    span.setAttribute('adk.fn.exc_repr', safeRepr(error, caps));
    return;
  }
  span.setAttribute('adk.fn.return', safeRepr(result, caps));
}

/**
 * True when `tracer` will record the spans it hands out.
 *
 * The probe span is deliberately never ended. An unended span is never
 * exported, so asking the question emits nothing.
 */
export function tracerWillRecord(tracer: Tracer): boolean {
  const span = tracer.startSpan(TRACER_PROBE_SPAN_NAME);
  return span.isRecording() || isSpanContextValid(span.spanContext());
}

/**
 * One function of each callable shape.
 *
 * They are never called. The module reads the prototypes they expose, which
 * are this realm's callable intrinsics, and comparing against those is safe
 * across two copies of the package in a way that a constructor-name check is
 * not.
 */
export const CALLABLE_SHAPE_SAMPLES: readonly TracedFunction[] = [
  function* (): Generator<never> {},
  async function* (): AsyncGenerator<never> {},
  async function (): Promise<void> {},
  function (): void {},
];

const [GENERATOR_SAMPLE, ASYNC_GENERATOR_SAMPLE, ASYNC_SAMPLE] =
  CALLABLE_SHAPE_SAMPLES;

/** Prototype shared by every generator function in this realm. */
const GENERATOR_FUNCTION_PROTOTYPE = Object.getPrototypeOf(
  GENERATOR_SAMPLE,
) as object;

/** Prototype shared by every async generator function in this realm. */
const ASYNC_GENERATOR_FUNCTION_PROTOTYPE = Object.getPrototypeOf(
  ASYNC_GENERATOR_SAMPLE,
) as object;

/** Prototype shared by every async function in this realm. */
const ASYNC_FUNCTION_PROTOTYPE = Object.getPrototypeOf(ASYNC_SAMPLE) as object;

/** What a wrapper needs to turn one call's arguments into span attributes. */
interface CallRecorder {
  /** Parameter names, resolved once when the wrapper was built. */
  readonly paramNames: readonly string[];
  /** Bounds applied to every rendered value. */
  readonly caps: Caps;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

/** Records one call's input and output on `span`, then ends it. */
function closeSpan(
  span: Span,
  recorder: CallRecorder,
  args: readonly unknown[],
  result: unknown,
  error: unknown,
): void {
  if (span.isRecording()) {
    const pairs = nameValuePairs(recorder.paramNames, args, recorder.caps);
    recordIoOnSpan(span, pairs, result, error, recorder.caps);
  }
  span.end();
}

/** Awaits `promise` inside `span`, recording whichever way it settles. */
async function recordSettledPromise(
  span: Span,
  recorder: CallRecorder,
  args: readonly unknown[],
  promise: PromiseLike<unknown>,
): Promise<unknown> {
  try {
    const value = await promise;
    closeSpan(span, recorder, args, value, undefined);
    return value;
  } catch (error) {
    closeSpan(span, recorder, args, undefined, error);
    throw error;
  }
}

/**
 * Wraps a plain function.
 *
 * A `Promise`-returning function that is not declared `async` is awaited
 * inside its span, otherwise the span closes before the work does. Python has
 * no analogue: there, only an `async def` returns an awaitable.
 */
function buildSyncWrapper(
  fn: TracedFunction,
  tracer: Tracer,
  displayName: string,
  recorder: CallRecorder,
): TracedFunction {
  return function tracingWrapper(this: unknown, ...args: unknown[]): unknown {
    return tracer.startActiveSpan(displayName, (span) => {
      let result: unknown;
      try {
        result = fn.apply(this, args);
      } catch (error) {
        closeSpan(span, recorder, args, undefined, error);
        throw error;
      }
      if (isPromiseLike(result)) {
        return recordSettledPromise(span, recorder, args, result);
      }
      closeSpan(span, recorder, args, result, undefined);
      return result;
    });
  };
}

/** Wraps an `async` function. */
function buildAsyncWrapper(
  fn: TracedFunction,
  tracer: Tracer,
  displayName: string,
  recorder: CallRecorder,
): TracedFunction {
  return async function tracingWrapper(
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    return tracer.startActiveSpan(displayName, (span) =>
      recordSettledPromise(
        span,
        recorder,
        args,
        fn.apply(this, args) as PromiseLike<unknown>,
      ),
    );
  };
}

/**
 * Wraps a generator function.
 *
 * The span ends in a `finally` so that a consumer who stops iterating early
 * still closes it. Spans opened inside the generator body are not nested
 * under this one: the generator suspends at every `yield`, and keeping an
 * OpenTelemetry context active across the suspension means taking over the
 * iteration protocol, which would drop the source generator's own cleanup.
 */
function buildGeneratorWrapper(
  fn: TracedFunction,
  tracer: Tracer,
  displayName: string,
  recorder: CallRecorder,
): TracedFunction {
  return function* tracingWrapper(
    this: unknown,
    ...args: unknown[]
  ): Generator<unknown> {
    const span = tracer.startSpan(displayName);
    const items: unknown[] = [];
    let total = 0;
    let failure: unknown;
    try {
      for (const item of fn.apply(this, args) as Iterable<unknown>) {
        total += 1;
        if (items.length < recorder.caps.maxRecordedYields) {
          items.push(item);
        }
        yield item;
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const stream = new StreamResult(items, recorder.caps, total);
      closeSpan(span, recorder, args, stream, failure);
    }
  };
}

/** Wraps an async generator function. See {@link buildGeneratorWrapper}. */
function buildAsyncGeneratorWrapper(
  fn: TracedFunction,
  tracer: Tracer,
  displayName: string,
  recorder: CallRecorder,
): TracedFunction {
  return async function* tracingWrapper(
    this: unknown,
    ...args: unknown[]
  ): AsyncGenerator<unknown> {
    const span = tracer.startSpan(displayName);
    const items: unknown[] = [];
    let total = 0;
    let failure: unknown;
    try {
      for await (const item of fn.apply(this, args) as AsyncIterable<unknown>) {
        total += 1;
        if (items.length < recorder.caps.maxRecordedYields) {
          items.push(item);
        }
        yield item;
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const stream = new StreamResult(items, recorder.caps, total);
      closeSpan(span, recorder, args, stream, failure);
    }
  };
}

/** Picks the wrapper whose shape matches `fn`. */
function selectWrapper(
  fn: TracedFunction,
  tracer: Tracer,
  displayName: string,
  recorder: CallRecorder,
): TracedFunction {
  const prototype = Object.getPrototypeOf(fn) as object | null;
  if (prototype === ASYNC_GENERATOR_FUNCTION_PROTOTYPE) {
    return buildAsyncGeneratorWrapper(fn, tracer, displayName, recorder);
  }
  if (prototype === GENERATOR_FUNCTION_PROTOTYPE) {
    return buildGeneratorWrapper(fn, tracer, displayName, recorder);
  }
  if (prototype === ASYNC_FUNCTION_PROTOTYPE) {
    return buildAsyncWrapper(fn, tracer, displayName, recorder);
  }
  return buildSyncWrapper(fn, tracer, displayName, recorder);
}

/**
 * Returns a tracing wrapper for `fn` that matches its shape: async generator,
 * generator, async, or plain.
 *
 * The wrapper keeps `fn`'s call semantics: the same arguments, the same
 * `this`, the same return value, the same thrown error, and the same `name`
 * and `length`. Parameter names are resolved here, once, rather than on every
 * call.
 *
 * The caller decides whether wrapping is worth it. {@link AutoTracingPlugin}
 * asks {@link tracerWillRecord} once, when it is constructed, and instruments
 * nothing when the answer is no; asking again here would start a throwaway
 * probe span for every function it wraps.
 */
export function buildTracingWrapper(
  fn: TracedFunction,
  tracer: Tracer,
  caps: Caps,
  ownerName?: string,
): TracedFunction {
  const recorder: CallRecorder = {paramNames: positionalParamNames(fn), caps};
  const wrapper = selectWrapper(
    fn,
    tracer,
    displayNameFor(fn, ownerName),
    recorder,
  );
  Object.defineProperties(wrapper, {
    name: {value: fn.name, configurable: true},
    length: {value: fn.length, configurable: true},
    [WRAPPED_MARKER]: {value: true},
  });
  return wrapper;
}
