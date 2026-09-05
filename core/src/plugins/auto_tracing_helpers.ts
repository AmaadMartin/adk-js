/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers for `AutoTracingPlugin`: argument capture, credential
 * redaction, span attributes and the tracing wrapper itself.
 *
 * Ported from adk-python `src/google/adk/plugins/auto_tracing_helpers.py`.
 */

import {
  context,
  isSpanContextValid,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

import {AuthCredentialTypes} from '../auth/auth_credential.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';

/** Default cap on the length of a rendered value written to a span. */
export const DEFAULT_MAX_REPR_LEN = 4096;

/** Default cap on how many of a generator's yields are sampled for a span. */
export const DEFAULT_MAX_RECORDED_YIELDS = 16;

/**
 * Marker property set on every wrapper this module builds.
 *
 * It lives in the global symbol registry so that two copies of `@google/adk`
 * in one runtime agree about which functions are already instrumented.
 */
export const AUTO_TRACING_WRAPPED = Symbol.for('adk.auto_tracing.wrapped');

/** Rendered in place of a function or method that carries no name. */
const ANONYMOUS = 'anonymous';

/** Parameter names the reference never records, ported verbatim. */
const SELF_OR_CLS: ReadonlySet<string> = new Set(['self', 'cls']);

/** Parameter and field names that conventionally carry secret material. */
const CREDENTIAL_ARG_NAMES: ReadonlySet<string> = new Set([
  'api_key',
  'auth_config',
  'auth_credential',
  'authorization',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'password',
  'private_key',
  'secret',
  'token',
]);

/**
 * Suffixes that mark a secret. A suffix rather than a substring, so that
 * `refresh_token` is masked while `tokenizer` and `user_token_count` are not.
 */
const CREDENTIAL_ARG_SUFFIXES = [
  '_api_key',
  '_auth_config',
  '_authorization',
  '_cookie',
  '_cookies',
  '_credential',
  '_credentials',
  '_password',
  '_private_key',
  '_secret',
  '_token',
] as const;

/**
 * Splits a camel-cased name so that `accessToken` and `apiKey` fold onto the
 * same `access_token` and `api_key` the rules above are written in. adk-js
 * names its fields in camel case, so without this fold the whole table would
 * miss every value it exists to protect.
 */
const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g;

/** How deep `safeRepr` renders before it elides a subtree. */
const MAX_RENDER_DEPTH = 10;

/**
 * How many containers and objects `safeRepr` renders before it elides
 * the rest. Generous on purpose: only containers and objects spend budget, so
 * an array of a million numbers costs one node.
 */
const MAX_RENDER_NODES = 1024;

/** Matches a parameter that binds a plain name. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Marks a rest parameter in a function's source. */
const REST_PREFIX = '...';

/** Matches an arrow function that declares its one parameter without parens. */
const BARE_ARROW_PARAM = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/;

/** Matches a class declaration or expression. */
const CLASS_SOURCE = /^class[\s{]/;

/** Every `authType` value an ADK auth credential can carry. */
const AUTH_CREDENTIAL_TYPES: ReadonlySet<string> = new Set(
  Object.values(AuthCredentialTypes),
);

/** The complete field set of an ADK `HttpCredentials`. */
const HTTP_CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  'username',
  'password',
  'token',
]);

/** The `OAuth2Auth` fields that carry a secret. */
const OAUTH2_SECRET_KEYS = [
  'clientSecret',
  'accessToken',
  'refreshToken',
  'idToken',
  'authCode',
  'codeVerifier',
  'authResponseUri',
] as const;

/** The complete field set of an ADK `OAuth2Auth`. */
const OAUTH2_KEYS: ReadonlySet<string> = new Set([
  ...OAUTH2_SECRET_KEYS,
  'clientId',
  'authUri',
  'nonce',
  'state',
  'redirectUri',
  'expiresAt',
  'expiresIn',
  'audience',
  'tokenEndpointAuthMethod',
]);

/**
 * A function the plugin can wrap.
 *
 * The parameters are `never[]` so that a function of any concrete signature is
 * assignable; a wrapper forwards whatever it receives without reading it.
 */
export type TracedFunction = (...args: never[]) => unknown;

/** Bounds for captured rendered strings and recorded generator yields. */
export interface Caps {
  /** Maximum length of a rendered value before it is truncated. */
  readonly maxReprLen: number;
  /** Maximum number of a generator's yields kept as a sample. */
  readonly maxRecordedYields: number;
}

/** One recorded argument: its name and its already rendered value. */
export interface NamedArg {
  /** The parameter name, or `arg<i>` when the signature supplied none. */
  readonly name: string;
  /** The rendered value, already capped and credential-masked. */
  readonly value: string;
}

/** The tag `safeRepr` recognizes a `StreamResult` by. */
const STREAM_RESULT_TAG = 'StreamResult';

/** Capped sample plus true yield count for a wrapped generator. */
export class StreamResult {
  /** Realm-safe brand, so the renderer need not use `instanceof`. */
  readonly [Symbol.toStringTag] = STREAM_RESULT_TAG;

  constructor(
    private readonly items: readonly unknown[],
    private readonly caps: Caps,
    private readonly total: number,
  ) {}

  toString(): string {
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

/** Realm-safe tag check; `instanceof` fails across two copies of a package. */
function hasTag(value: unknown, tag: string): boolean {
  return Object.prototype.toString.call(value) === `[object ${tag}]`;
}

export function isMap(value: object): value is Map<unknown, unknown> {
  return hasTag(value, 'Map');
}

export function isSet(value: object): value is Set<unknown> {
  return hasTag(value, 'Set');
}

/**
 * Whether `value` is an ordinary object or a class instance, rather than a
 * kind the runtime owns.
 *
 * Every built-in reports a tag of its own -- `Uint8Array` for a Buffer, and
 * `URL`, `Promise` or `process` for the rest -- while a plain object and a
 * class instance both report `Object`.
 */
export function isPlainTagged(value: object): boolean {
  return hasTag(value, 'Object');
}

function isError(value: object): value is Error {
  return hasTag(value, 'Error');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether the value is a mapping rather than an instance of some class. */
function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

/** The constructor name of a value, used to label it in a rendering. */
export function typeLabel(value: unknown): string {
  if (value === null) {
    return 'Null';
  }
  if (value === undefined) {
    return 'Undefined';
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    typeof prototype !== 'object' ||
    prototype === null ||
    !('constructor' in prototype)
  ) {
    return 'Object';
  }
  const constructor: unknown = prototype.constructor;
  if (typeof constructor === 'function' && constructor.name.length > 0) {
    return constructor.name;
  }
  return 'Object';
}

/**
 * Whether a parameter or field called `name` conventionally holds a secret.
 *
 * The name is folded to snake case first, so `accessToken`, `access-token`
 * and `access_token` all match the same rule.
 */
function isCredentialArgName(name: string): boolean {
  const normalized = name
    .replace(CAMEL_BOUNDARY, '_')
    .toLowerCase()
    .replaceAll('-', '_');
  return (
    CREDENTIAL_ARG_NAMES.has(normalized) ||
    CREDENTIAL_ARG_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function isAuthCredential(value: Record<string, unknown>): boolean {
  const authType = value['authType'];
  return typeof authType === 'string' && AUTH_CREDENTIAL_TYPES.has(authType);
}

function isServiceAccountCredential(value: Record<string, unknown>): boolean {
  return value['type'] === 'service_account';
}

function isServiceAccount(value: Record<string, unknown>): boolean {
  if ('serviceAccountCredential' in value) {
    return true;
  }
  return (
    'scopes' in value &&
    ('useDefaultCredential' in value || 'useIdToken' in value)
  );
}

function isHttpAuth(value: Record<string, unknown>): boolean {
  return typeof value['scheme'] === 'string' && isRecord(value['credentials']);
}

/**
 * Two keys minimum: a lone `{token}` is any caller's object, and collapsing it
 * wholesale would hide the rest of a traced value. Its key name masks it.
 */
function isHttpCredentials(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length >= 2 && keys.every((key) => HTTP_CREDENTIAL_KEYS.has(key));
}

/**
 * Whether the value is an `OAuth2Auth` rather than some caller's object that
 * happens to carry a token. Every key must be an `OAuth2Auth` field.
 */
function isOAuth2Auth(value: Record<string, unknown>): boolean {
  return (
    OAUTH2_SECRET_KEYS.some((key) => key in value) &&
    Object.keys(value).every((key) => OAUTH2_KEYS.has(key))
  );
}

/**
 * Whether a value's shape identifies it as one of the ADK credential types,
 * in which case it is replaced wholesale rather than rendered field by field.
 *
 * adk-js declares its credential types as interfaces, which are erased at run
 * time, so the check has to be structural. That is also what the repository
 * requires of a type check: `instanceof` reports false when two copies of a
 * package share a runtime.
 */
function isCredentialLike(value: object): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isAuthCredential(value) ||
    isServiceAccountCredential(value) ||
    isServiceAccount(value) ||
    isHttpAuth(value) ||
    isHttpCredentials(value) ||
    isOAuth2Auth(value)
  );
}

/** Bounds carried through one `safeRepr` rendering. */
interface RenderState {
  readonly active: Set<object>;
  nodes: number;
}

function quoteString(text: string): string {
  // A function replacement, because a string one expands `$&` and friends.
  const escaped = text.replace(/[\\']/g, (match) => `\\${match}`);
  return `'${escaped}'`;
}

function render(value: unknown, depth: number, state: RenderState): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return quoteString(value);
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
    case 'undefined':
      return String(value);
    case 'function':
      return `<Function ${value.name || ANONYMOUS}>`;
    default:
      return renderObject(value, depth, state);
  }
}

function renderObject(
  value: object,
  depth: number,
  state: RenderState,
): string {
  if (isCredentialLike(value)) {
    return `<${typeLabel(value)}>`;
  }
  if (hasTag(value, STREAM_RESULT_TAG)) {
    // Its own rendering already puts every sampled item through safeRepr, so
    // describing it field by field would only restate the count it reports.
    return String(value);
  }
  state.nodes -= 1;
  if (state.nodes < 0 || depth >= MAX_RENDER_DEPTH || state.active.has(value)) {
    return `<${typeLabel(value)} ...>`;
  }
  state.active.add(value);
  try {
    return describe(value, depth + 1, state);
  } finally {
    state.active.delete(value);
  }
}

/** Renders a member, masking it by name before its value is ever read. */
function renderMember(
  key: string,
  value: unknown,
  depth: number,
  state: RenderState,
): string {
  if (isCredentialArgName(key)) {
    return `<${typeLabel(value)}>`;
  }
  return render(value, depth, state);
}

function describe(value: object, depth: number, state: RenderState): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => render(item, depth, state));
    return `[${items.join(', ')}]`;
  }
  if (isMap(value)) {
    const entries = [...value].map(([key, item]) => {
      const renderedKey = render(key, depth, state);
      const renderedItem =
        typeof key === 'string'
          ? renderMember(key, item, depth, state)
          : render(item, depth, state);
      return `${renderedKey} => ${renderedItem}`;
    });
    return `Map(${value.size}) {${entries.join(', ')}}`;
  }
  if (isSet(value)) {
    const items = [...value].map((item) => render(item, depth, state));
    return `Set(${value.size}) {${items.join(', ')}}`;
  }
  if (isError(value)) {
    return `${typeLabel(value)}(${quoteString(value.message)})`;
  }
  const entries = Object.entries(value);
  if (isPlainObject(value)) {
    const fields = entries.map(
      ([key, item]) => `${key}: ${renderMember(key, item, depth, state)}`,
    );
    return `{${fields.join(', ')}}`;
  }
  // A class instance is summarized from its public fields only. Its own
  // `toString` is never consulted: it may print private state, and the
  // rendering must not show more than the summary admits to.
  const fields = entries
    .filter(([key]) => !key.startsWith('_'))
    .map(([key, item]) => `${key}=${renderMember(key, item, depth, state)}`);
  const label = typeLabel(value);
  return fields.length > 0
    ? `<${label} fields={${fields.join(', ')}}>`
    : `<${label}>`;
}

function capLength(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...[${text.length - maxLength} more chars]`;
}

/**
 * Renders `value` for a span attribute: capped, credential-masked, and never
 * throwing.
 *
 * A rendering that fails part way elides the whole value to `<Name ...>`
 * rather than falling back to a partial rendering, because a walk that
 * stopped early proves nothing about what the value holds.
 */
export function safeRepr(value: unknown, caps: Caps): string {
  let rendered: string;
  try {
    rendered = render(value, 0, {
      active: new Set<object>(),
      nodes: MAX_RENDER_NODES,
    });
  } catch (error: unknown) {
    logger.warn(
      `AutoTracingPlugin: rendering ${typeLabel(value)} failed: ${formatError(error)}`,
    );
    rendered = `<${typeLabel(value)} ...>`;
  }
  return capLength(rendered, caps.maxReprLen);
}

/**
 * The top-level parameter tokens of `fn`'s source, trimmed and in order.
 *
 * The scan tracks bracket depth and string literals, so a default value that
 * itself holds a comma or a bracket does not split a token. Source it cannot
 * read at all yields no tokens.
 */
function parameterTokens(fn: unknown): string[] {
  if (typeof fn !== 'function') {
    return [];
  }
  const source = Function.prototype.toString.call(fn).trim();
  if (CLASS_SOURCE.test(source)) {
    return [];
  }
  const bare = BARE_ARROW_PARAM.exec(source);
  if (bare !== null) {
    return [bare[1]];
  }
  const open = source.indexOf('(');
  if (open < 0) {
    return [];
  }
  const tokens: string[] = [];
  let depth = 0;
  let quote = '';
  let start = open + 1;
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (quote !== '') {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        tokens.push(source.slice(start, index).trim());
        return tokens.length === 1 && tokens[0] === '' ? [] : tokens;
      }
    } else if (char === ',' && depth === 1) {
      tokens.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  return [];
}

/** The binding a parameter token declares, without its default value. */
function bindingOf(token: string): string {
  // A binding identifier holds no `=`, so everything before the first one is
  // the binding however complex the default is.
  return token.split('=', 1)[0].trim();
}

/**
 * Reads `fn`'s positional parameter names out of its source.
 *
 * Each parameter is resolved on its own, so a default value on one of them
 * does not cost the others their names — losing a name loses the credential
 * check that keys off it. A parameter with no readable name, such as a
 * destructured one, is reported as `arg<i>`, and a rest parameter names
 * nothing here: `restParamName` names the arguments it collects.
 *
 * A minifier renames parameters, so names are best-effort in a bundled build.
 */
export function positionalParamNames(fn: unknown): readonly string[] {
  const names: string[] = [];
  parameterTokens(fn).forEach((token, index) => {
    if (token.startsWith(REST_PREFIX)) {
      return;
    }
    const binding = bindingOf(token);
    names.push(IDENTIFIER.test(binding) ? binding : `arg${index}`);
  });
  return names;
}

/**
 * The name of `fn`'s rest parameter, which names every argument it collects.
 *
 * Without it a secret passed into `...credentials` would be recorded under
 * `arg<i>`, where no name marks it as one.
 */
export function restParamName(fn: unknown): string | undefined {
  const tokens = parameterTokens(fn);
  const last = tokens[tokens.length - 1];
  if (last === undefined || !last.startsWith(REST_PREFIX)) {
    return undefined;
  }
  const binding = bindingOf(last.slice(REST_PREFIX.length));
  return IDENTIFIER.test(binding) ? binding : undefined;
}

/**
 * Names the call's arguments and renders each one.
 *
 * An argument whose name marks it as secret is dropped outright rather than
 * masked: at the top level the name alone already says the call took a token.
 * A secret nested inside a recorded argument is masked in place instead, so
 * that the shape of the traced value is still reported.
 *
 * @param params.restName Names every argument past `paramNames`, for a
 *     signature that ends in a rest parameter. Arguments beyond a signature
 *     that does not are recorded as `arg<i>`.
 */
export function nameValuePairs(params: {
  paramNames: readonly string[];
  args: readonly unknown[];
  caps: Caps;
  restName?: string;
}): NamedArg[] {
  const {paramNames, args, caps, restName} = params;
  const pairs: NamedArg[] = [];
  args.forEach((value, index) => {
    const name = paramNames[index] ?? restName ?? `arg${index}`;
    if (SELF_OR_CLS.has(name) || isCredentialArgName(name)) {
      return;
    }
    pairs.push({name, value: safeRepr(value, caps)});
  });
  return pairs;
}

/**
 * Writes the `adk.fn.*` attributes for one call onto `span`.
 *
 * @param params.error The thrown value, or `undefined` when the call
 *     returned. A call that threw `undefined` is recorded as a return.
 */
export function recordIoOnSpan(params: {
  span: Span;
  pairs: readonly NamedArg[];
  result: unknown;
  error: unknown;
  caps: Caps;
}): void {
  const {span, pairs, result, error, caps} = params;
  for (const {name, value} of pairs) {
    // Repeats the filter in nameValuePairs on purpose. This function is
    // exported and takes the pairs its caller built, so it cannot assume they
    // went through that filter; a span attribute is the boundary that matters.
    if (isCredentialArgName(name)) {
      continue;
    }
    span.setAttribute(`adk.fn.arg.${name}`, value);
  }
  if (error !== undefined) {
    span.setAttribute('adk.fn.exc_type', typeLabel(error));
    span.setAttribute('adk.fn.exc_repr', safeRepr(error, caps));
    return;
  }
  span.setAttribute('adk.fn.return', safeRepr(result, caps));
}

/** The span name for `fn`: `Owner.method`, or just the function's own name. */
export function displayNameFor(fn: TracedFunction, ownerName?: string): string {
  const name = fn.name || ANONYMOUS;
  return ownerName === undefined ? name : `${ownerName}.${name}`;
}

/** One probe per tracer: the answer cannot change for a given tracer. */
const tracerRecords = new WeakMap<Tracer, boolean>();

/**
 * Whether `tracer` will record, so that instrumenting anything is worthwhile.
 *
 * `@opentelemetry/api` 1.9.0 exports no noop-tracer type to compare against,
 * and `instanceof` is unreliable across two copies of a package, so this
 * probes instead. The probe is not free: the SDK's `Span` constructor runs the
 * sampler and calls `onStart` on every registered span processor. It is never
 * ended, so no processor sees it again and it is never exported, and the
 * result is cached so that one tracer costs one probe however many functions
 * are wrapped with it.
 */
export function tracerWillRecord(tracer: Tracer): boolean {
  const cached = tracerRecords.get(tracer);
  if (cached !== undefined) {
    return cached;
  }
  const span = tracer.startSpan('adk.auto_tracing.probe');
  const records = span.isRecording() || isSpanContextValid(span.spanContext());
  tracerRecords.set(tracer, records);
  return records;
}

/** Whether `value` is callable, and so a candidate for wrapping. */
export function isTracedFunction(value: unknown): value is TracedFunction {
  return typeof value === 'function';
}

/**
 * Whether `fn` is a class constructor. A class cannot be wrapped: the wrapper
 * is an ordinary function, and calling it with `new` would build the wrong
 * thing.
 */
export function isClassConstructor(fn: TracedFunction): boolean {
  return CLASS_SOURCE.test(Function.prototype.toString.call(fn).trim());
}

function isAsyncGeneratorFunction(
  fn: TracedFunction,
): fn is (...args: never[]) => AsyncIterable<unknown> {
  return hasTag(fn, 'AsyncGeneratorFunction');
}

function isGeneratorFunction(
  fn: TracedFunction,
): fn is (...args: never[]) => Iterable<unknown> {
  return hasTag(fn, 'GeneratorFunction');
}

function isAsyncFunction(
  fn: TracedFunction,
): fn is (...args: never[]) => Promise<unknown> {
  return hasTag(fn, 'AsyncFunction');
}

/**
 * True while a wrapper is inside its own tracing work.
 *
 * The tracer's own code path runs ordinary functions, and any of them may be
 * one the plugin has wrapped. `Buffer.prototype` is the concrete case: the
 * OpenTelemetry SDK uses a Buffer while it opens a span, so tracing that call
 * opens another span, which calls it again, until the stack runs out. A
 * wrapper reached while this is set calls straight through instead.
 *
 * The flag is only ever held across synchronous work, never across an `await`
 * or a `yield`, so two concurrent calls cannot see each other's.
 */
let recordingSpan = false;

/** Runs the plugin's own tracing work, which is never itself traced. */
function whileRecording<T>(action: () => T): T {
  recordingSpan = true;
  try {
    return action();
  } finally {
    recordingSpan = false;
  }
}

/**
 * Names and marks a wrapper, then reports it under the wrapped function's own
 * type. The assertion is the one place the signature is restated: a wrapper
 * forwards every argument and every result untouched, so it behaves as `F`,
 * but `F` is opaque to the generic body that builds it.
 */
function markWrapper<F extends TracedFunction>(
  wrapper: TracedFunction,
  fn: F,
): F {
  Object.defineProperty(wrapper, 'name', {value: fn.name, configurable: true});
  Object.defineProperty(wrapper, 'length', {
    value: fn.length,
    configurable: true,
  });
  // The analogue of the reference's functools.wraps copying __dict__: a
  // property a caller attached to the function is part of its interface.
  Object.assign(wrapper, fn);
  Object.defineProperty(wrapper, AUTO_TRACING_WRAPPED, {value: true});
  return wrapper as F;
}

/** Whether `value` is a function this module has already wrapped. */
export function isTraced(value: unknown): boolean {
  return typeof value === 'function' && AUTO_TRACING_WRAPPED in value;
}

/**
 * Returns a tracing wrapper for `fn` that matches its sync, async, generator
 * or async-generator shape.
 *
 * The wrapper is observationally identical to `fn`: same return value, same
 * thrown error, same yields in the same order, and the same `name`. A
 * non-recording tracer gets `fn` back unchanged, so nothing pays for a span
 * that will never be exported.
 */
export function buildTracingWrapper<F extends TracedFunction>(params: {
  fn: F;
  tracer: Tracer;
  caps: Caps;
  ownerName?: string;
}): F {
  const {fn, tracer, caps, ownerName} = params;
  if (!tracerWillRecord(tracer)) {
    return fn;
  }

  const displayName = displayNameFor(fn, ownerName);
  // Signature introspection is expensive; resolve it once, here, not per call.
  const paramNames = positionalParamNames(fn);
  const restName = restParamName(fn);
  const yieldCap = caps.maxRecordedYields;

  function finish(
    span: Span,
    args: readonly unknown[],
    result: unknown,
    error: unknown,
  ): void {
    if (!span.isRecording()) {
      return;
    }
    const pairs = nameValuePairs({paramNames, args, caps, restName});
    recordIoOnSpan({span, pairs, result, error, caps});
  }

  if (isAsyncGeneratorFunction(fn)) {
    const target = fn;
    return markWrapper(async function* (
      this: unknown,
      ...args: never[]
    ): AsyncGenerator<unknown, void, unknown> {
      if (recordingSpan) {
        yield* target.apply(this, args);
        return;
      }
      // A generator suspends at every yield, so its span cannot stay
      // context-active across the suspension without leaking the context into
      // the consumer's frame. The span is ended in `finally`, which also
      // covers a consumer that breaks out of the loop early.
      const span = whileRecording(() => tracer.startSpan(displayName));
      const items: unknown[] = [];
      let total = 0;
      let failure: unknown;
      try {
        for await (const item of target.apply(this, args)) {
          total += 1;
          if (items.length < yieldCap) {
            items.push(item);
          }
          yield item;
        }
      } catch (error: unknown) {
        failure = error;
        throw error;
      } finally {
        whileRecording(() => {
          finish(span, args, new StreamResult(items, caps, total), failure);
          span.end();
        });
      }
    }, fn);
  }

  if (isGeneratorFunction(fn)) {
    const target = fn;
    return markWrapper(function* (
      this: unknown,
      ...args: never[]
    ): Generator<unknown, void, unknown> {
      if (recordingSpan) {
        yield* target.apply(this, args);
        return;
      }
      const span = whileRecording(() => tracer.startSpan(displayName));
      const items: unknown[] = [];
      let total = 0;
      let failure: unknown;
      try {
        for (const item of target.apply(this, args)) {
          total += 1;
          if (items.length < yieldCap) {
            items.push(item);
          }
          yield item;
        }
      } catch (error: unknown) {
        failure = error;
        throw error;
      } finally {
        whileRecording(() => {
          finish(span, args, new StreamResult(items, caps, total), failure);
          span.end();
        });
      }
    }, fn);
  }

  if (isAsyncFunction(fn)) {
    const target = fn;
    return markWrapper(async function (
      this: unknown,
      ...args: never[]
    ): Promise<unknown> {
      if (recordingSpan) {
        return target.apply(this, args);
      }
      // startSpan plus context.with rather than startActiveSpan, so that the
      // span's creation is guarded without the call it wraps being guarded too.
      const span = whileRecording(() => tracer.startSpan(displayName));
      const active = trace.setSpan(context.active(), span);
      try {
        const result = await context.with(active, () =>
          target.apply(this, args),
        );
        whileRecording(() => finish(span, args, result, undefined));
        return result;
      } catch (error: unknown) {
        whileRecording(() => finish(span, args, undefined, error));
        throw error;
      } finally {
        whileRecording(() => span.end());
      }
    }, fn);
  }

  const target = fn;
  return markWrapper(function (this: unknown, ...args: never[]): unknown {
    if (recordingSpan) {
      return target.apply(this, args);
    }
    const span = whileRecording(() => tracer.startSpan(displayName));
    const active = trace.setSpan(context.active(), span);
    try {
      const result = context.with(active, () => target.apply(this, args));
      whileRecording(() => finish(span, args, result, undefined));
      return result;
    } catch (error: unknown) {
      whileRecording(() => finish(span, args, undefined, error));
      throw error;
    } finally {
      whileRecording(() => span.end());
    }
  }, fn);
}
