/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Decoding for the legacy v0 session schema's pickled `events.actions` column.
 *
 * The v0 schema stored `EventActions` as a Python pickle blob. Bytes read back
 * from that column are untrusted input, so they go through
 * {@link loadPickle}, which executes nothing, and every name the payload
 * mentions is checked against an allowlist of the types `EventActions` can
 * hold. This mirrors `google/adk-python`'s
 * `src/google/adk/sessions/_restricted_pickle.py`.
 *
 * adk-python derives most of its allowlist by walking Pydantic annotations.
 * TypeScript has no runtime annotations to walk, so the list here is static,
 * with two whole modules and one module prefix admitted so that the auth and
 * `google.genai` models do not have to be enumerated leaf by leaf. Admitting a
 * module is safe because nothing is resolved to a callable and nothing is run;
 * an admitted name only ever becomes inert data.
 */

import {transformToCamelCaseEvent} from '../events/event.js';
import {createEventActions, EventActions} from '../events/event_actions.js';
import {GlobalResolver, loadPickle} from '../utils/pickle_reader.js';

/** How `loadEventActions` treats a global outside the allowlist. */
export interface RestrictedPickleOptions {
  /**
   * Reconstruct a global outside the allowlist as opaque data instead of
   * refusing it.
   *
   * This is weaker than adk-python's flag of the same name: the TypeScript
   * reader never executes a payload, so turning the allowlist off cannot run
   * code. It only lets a value of an unrecognised type through as a plain
   * object of whatever state the payload set on it.
   */
  allowUnsafeUnpickling?: boolean;
}

/**
 * Globals admitted by exact `module.name`.
 *
 * The `builtins` scalar types have no reconstructor of their own: they appear
 * as a bare `GLOBAL` (a `collections.defaultdict` records its factory that
 * way), never applied to arguments.
 */
const ALLOWED_GLOBALS: ReadonlySet<string> = new Set([
  'builtins.bool',
  'builtins.bytearray',
  'builtins.bytes',
  'builtins.dict',
  'builtins.float',
  'builtins.frozenset',
  'builtins.int',
  'builtins.list',
  'builtins.set',
  'builtins.str',
  'builtins.tuple',
  // The Python 2 spelling, which a protocol 2 payload still uses.
  '__builtin__.set',
  'collections.OrderedDict',
  'collections.defaultdict',
  'datetime.date',
  'datetime.datetime',
  'datetime.time',
  'datetime.timedelta',
  'datetime.timezone',
  'decimal.Decimal',
  'uuid.UUID',
  'google.adk.events.event_actions.EventActions',
  'google.adk.events.event_actions.EventCompaction',
  'google.adk.events.ui_widget.UiWidget',
  'google.adk.tools.tool_confirmation.ToolConfirmation',
]);

/** Modules whose every member is admitted. */
const ALLOWED_MODULES: ReadonlySet<string> = new Set([
  // The auth schemes `AuthConfig.auth_scheme` holds are FastAPI models.
  'fastapi.openapi.models',
  'google.genai.types',
]);

/** Module prefixes whose every member is admitted. */
const ALLOWED_MODULE_PREFIXES: readonly string[] = ['google.adk.auth.'];

/** Marks a record this module built to stand in for a Python object. */
const PICKLE_GLOBAL: unique symbol = Symbol('adk.pickledGlobal');

/** The global a payload named, and the arguments it applied to it. */
interface PickledGlobalRef {
  readonly module: string;
  readonly name: string;
  readonly args: readonly unknown[];
}

/**
 * An inert stand-in for a Python object. `BUILD` copies the object's state
 * onto it as ordinary string-keyed properties.
 */
type PickledInstance = Record<string, unknown> & {
  readonly [PICKLE_GLOBAL]: PickledGlobalRef;
};

/**
 * Deepest nesting `toJsonValue` will follow. A pickle payload can name the
 * same container inside itself, which would otherwise recurse forever.
 */
const MAX_VALUE_DEPTH = 64;

/** Byte width of the packed argument each `datetime` type reconstructs from. */
const DATETIME_BYTES = 10;
const DATE_BYTES = 4;
const TIME_BYTES = 6;

const SECONDS_PER_DAY = 86400;
const SECONDS_PER_MINUTE = 60;
const MICROSECOND_DIGITS = 6;

function isPickledInstance(value: unknown): value is PickledInstance {
  return typeof value === 'object' && value !== null && PICKLE_GLOBAL in value;
}

/** Returns the `module.name` key a resolved global is recorded under. */
function globalKey(ref: PickledGlobalRef): string {
  return `${ref.module}.${ref.name}`;
}

/** Reads a packed argument of the exact width a `datetime` type uses. */
function packedBytes(
  args: readonly unknown[],
  width: number,
  typeName: string,
): Uint8Array {
  const packed = args[0];
  if (!ArrayBuffer.isView(packed) || packed.byteLength !== width) {
    throw new Error(
      `A pickled ${typeName} needs a ${width}-byte argument, got ${describe(packed)}.`,
    );
  }
  return new Uint8Array(packed.buffer, packed.byteOffset, width);
}

/** Reads an integer argument, rejecting anything that is not one. */
function integerArg(
  args: readonly unknown[],
  index: number,
  typeName: string,
): number {
  const value = args[index];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(
      `A pickled ${typeName} needs integer arguments, got ${describe(value)}.`,
    );
  }
  return value;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Formats a fixed UTC offset as `Z`, `+HH:MM` or `-HH:MM`. */
function formatOffset(minutes: number): string {
  if (minutes === 0) {
    return 'Z';
  }
  const sign = minutes < 0 ? '-' : '+';
  const total = Math.abs(minutes);
  return `${sign}${pad(Math.floor(total / 60), 2)}:${pad(total % 60, 2)}`;
}

/**
 * Formats a decoded timestamp the way Pydantic's JSON mode writes one, so the
 * migrated value matches what a v1 database written by adk-python holds.
 */
function formatTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  microsecond: number,
  offsetMinutes: number | undefined,
): string {
  const fraction =
    microsecond === 0 ? '' : `.${pad(microsecond, MICROSECOND_DIGITS)}`;
  const naive =
    `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` +
    `T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}${fraction}`;
  return offsetMinutes === undefined
    ? naive
    : `${naive}${formatOffset(offsetMinutes)}`;
}

/** Reads the `(days, seconds, microseconds)` a pickled `timedelta` carries. */
function timedeltaParts(
  value: unknown,
): {days: number; seconds: number; microseconds: number} | undefined {
  if (!isPickledInstance(value)) {
    return undefined;
  }
  const ref = value[PICKLE_GLOBAL];
  if (globalKey(ref) !== 'datetime.timedelta') {
    return undefined;
  }
  return {
    days: integerArg(ref.args, 0, 'timedelta'),
    seconds: integerArg(ref.args, 1, 'timedelta'),
    microseconds: integerArg(ref.args, 2, 'timedelta'),
  };
}

/** Reads the UTC offset a pickled `datetime.timezone` carries, in minutes. */
function timezoneOffsetMinutes(timezone: PickledInstance): number {
  const parts = timedeltaParts(timezone[PICKLE_GLOBAL].args[0]);
  if (parts === undefined) {
    throw new Error('A pickled timezone does not hold a timedelta offset.');
  }
  return (parts.days * SECONDS_PER_DAY + parts.seconds) / SECONDS_PER_MINUTE;
}

/**
 * Reads the UTC offset a pickled datetime's `tzinfo` argument carries.
 * Returns `undefined` for a naive datetime, whose argument is absent or null.
 */
function tzinfoOffsetMinutes(tzinfo: unknown): number | undefined {
  if (tzinfo === undefined || tzinfo === null) {
    return undefined;
  }
  if (
    !isPickledInstance(tzinfo) ||
    globalKey(tzinfo[PICKLE_GLOBAL]) !== 'datetime.timezone'
  ) {
    throw new Error(
      'A pickled datetime carries a tzinfo that is not a fixed offset.',
    );
  }
  return timezoneOffsetMinutes(tzinfo);
}

/** Reconstructs `datetime.datetime` from its packed argument. */
function datetimeFromArgs(args: readonly unknown[]): string {
  const packed = packedBytes(args, DATETIME_BYTES, 'datetime');
  return formatTimestamp(
    (packed[0] << 8) | packed[1],
    // The high bit of the month byte is the "fold" flag, not part of the month.
    packed[2] & 0x7f,
    packed[3],
    packed[4],
    packed[5],
    packed[6],
    (packed[7] << 16) | (packed[8] << 8) | packed[9],
    tzinfoOffsetMinutes(args[1]),
  );
}

/** Reconstructs `datetime.date` from its packed argument. */
function dateFromArgs(args: readonly unknown[]): string {
  const packed = packedBytes(args, DATE_BYTES, 'date');
  return `${pad((packed[0] << 8) | packed[1], 4)}-${pad(packed[2], 2)}-${pad(packed[3], 2)}`;
}

/** Reconstructs `datetime.time` from its packed argument. */
function timeFromArgs(args: readonly unknown[]): string {
  const packed = packedBytes(args, TIME_BYTES, 'time');
  const microsecond = (packed[3] << 16) | (packed[4] << 8) | packed[5];
  const fraction =
    microsecond === 0 ? '' : `.${pad(microsecond, MICROSECOND_DIGITS)}`;
  return `${pad(packed[0], 2)}:${pad(packed[1], 2)}:${pad(packed[2], 2)}${fraction}`;
}

/** Formats a `timedelta` as the ISO-8601 duration Pydantic's JSON mode writes. */
function formatDuration(parts: {
  days: number;
  seconds: number;
  microseconds: number;
}): string {
  const dayPart = parts.days === 0 ? '' : `${parts.days}D`;
  const fraction =
    parts.microseconds === 0
      ? ''
      : `.${pad(parts.microseconds, MICROSECOND_DIGITS)}`;
  return `P${dayPart}T${parts.seconds}${fraction}S`;
}

/** Formats the 128-bit integer a pickled `uuid.UUID` holds. */
function formatUuid(value: unknown): string {
  if (typeof value !== 'bigint' && typeof value !== 'number') {
    throw new Error(`A pickled UUID holds ${describe(value)}, not an integer.`);
  }
  const hex = BigInt(value).toString(16).padStart(32, '0');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** Builds a value for a global the payload applies to arguments. */
type Reconstructor = (args: readonly unknown[]) => unknown;

/**
 * Globals that reconstruct to a value rather than to an inert record.
 *
 * A container has to reconstruct to the matching JavaScript container, because
 * the payload goes on to fill it with `SETITEMS`, `APPENDS` or `ADDITEMS`.
 */
const RECONSTRUCTORS: ReadonlyMap<string, Reconstructor> = new Map<
  string,
  Reconstructor
>([
  ['builtins.set', (args) => setFromArgs(args)],
  ['builtins.frozenset', (args) => setFromArgs(args)],
  ['__builtin__.set', (args) => setFromArgs(args)],
  ['collections.OrderedDict', () => new Map<unknown, unknown>()],
  // The single argument is the factory, which is never called and is dropped.
  ['collections.defaultdict', () => new Map<unknown, unknown>()],
  ['datetime.datetime', datetimeFromArgs],
  ['datetime.date', dateFromArgs],
  ['datetime.time', timeFromArgs],
  ['decimal.Decimal', (args) => String(args[0])],
]);

/** Reconstructs a Python set, whose single argument is an iterable of members. */
function setFromArgs(args: readonly unknown[]): Set<unknown> {
  const members = args[0];
  return new Set(Array.isArray(members) ? members : []);
}

/** Names a value in an error message without printing its contents. */
function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return typeof value;
}

/** The message that refuses a global outside the allowlist. */
function refusalMessage(module: string, name: string): string {
  return (
    `Refusing to load ${module}.${name} from a legacy pickled ` +
    '"events.actions" value: it is not a type that EventActions can hold. ' +
    'This value was either not written by ADK, or it holds session state ' +
    'that is not plain data. To recover a database whose contents you ' +
    'trust, migrate it with the allowUnsafeUnpickling option.'
  );
}

function isAllowed(module: string, name: string): boolean {
  return (
    ALLOWED_GLOBALS.has(`${module}.${name}`) ||
    ALLOWED_MODULES.has(module) ||
    ALLOWED_MODULE_PREFIXES.some((prefix) => module.startsWith(prefix))
  );
}

/** Builds the resolver `loadPickle` consults for every name in the payload. */
function createResolver(options: RestrictedPickleOptions): GlobalResolver {
  return (module, name) => {
    const reconstruct = RECONSTRUCTORS.get(`${module}.${name}`);
    if (reconstruct !== undefined) {
      return {construct: (args) => reconstruct(args)};
    }
    if (!isAllowed(module, name) && options.allowUnsafeUnpickling !== true) {
      throw new Error(refusalMessage(module, name));
    }
    return {
      construct: (args): PickledInstance => ({
        [PICKLE_GLOBAL]: {module, name, args},
      }),
    };
  };
}

/** Converts a Python dict, keyed by whatever the payload used, to an object. */
function objectFromMap(
  source: Map<unknown, unknown>,
  depth: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of source) {
    // JSON has string keys only; a non-string Python key keeps its text form.
    result[typeof key === 'string' ? key : String(key)] = toJsonValue(
      value,
      depth,
    );
  }
  return result;
}

/** Converts an object's own string-keyed properties to plain JSON data. */
function objectFromProperties(
  source: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    result[key] = toJsonValue(value, depth);
  }
  return result;
}

/** Pydantic keeps a model's fields under this key, beside its private state. */
const PYDANTIC_FIELDS_KEY = '__dict__';

/** Converts an inert record standing in for a Python object to JSON data. */
function instanceToJsonValue(
  instance: PickledInstance,
  depth: number,
): unknown {
  const ref = instance[PICKLE_GLOBAL];
  const key = globalKey(ref);
  if (key === 'uuid.UUID') {
    return formatUuid(instance['int']);
  }
  if (key === 'datetime.timezone') {
    return formatOffset(timezoneOffsetMinutes(instance));
  }
  const duration = timedeltaParts(instance);
  if (duration !== undefined) {
    return formatDuration(duration);
  }
  const fields = instance[PYDANTIC_FIELDS_KEY];
  if (fields instanceof Map) {
    return objectFromMap(fields, depth);
  }
  return objectFromProperties(instance, depth);
}

/**
 * Converts a value the reader produced into plain JSON data: the shape
 * `model_dump(mode="json")` would have written, and the shape adk-js stores in
 * the v1 `event_data` column.
 */
function toJsonValue(value: unknown, depth: number): unknown {
  if (depth > MAX_VALUE_DEPTH) {
    throw new Error(
      `A legacy pickled "events.actions" value nests deeper than ${MAX_VALUE_DEPTH} levels.`,
    );
  }
  const next = depth + 1;
  if (typeof value === 'bigint') {
    // Outside the double range, so its decimal text is the lossless form.
    return value.toString();
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    // Base64, matching how adk-js carries binary payloads such as
    // `Part.inlineData.data`. adk-python's own migration cannot write this
    // case at all: `model_dump(mode="json")` decodes bytes as UTF-8 and
    // raises on anything else.
    return Buffer.from(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).toString('base64');
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item, next));
  }
  if (value instanceof Set) {
    return [...value].map((item) => toJsonValue(item, next));
  }
  if (value instanceof Map) {
    return objectFromMap(value, next);
  }
  if (isPickledInstance(value)) {
    return instanceToJsonValue(value, next);
  }
  throw new Error(
    'A legacy pickled "events.actions" value decoded to an unexpected object.',
  );
}

/**
 * Decodes a legacy v0 `events.actions` blob into adk-js {@link EventActions}.
 *
 * @param data The pickled bytes read from the `events.actions` column.
 * @param options Whether to accept a global outside the allowlist.
 * @return The decoded actions, with every dictionary field populated.
 * @throws If the payload is malformed, or names a type outside the allowlist
 *   and {@link RestrictedPickleOptions.allowUnsafeUnpickling} is not set.
 */
export function loadEventActions(
  data: Uint8Array,
  options: RestrictedPickleOptions = {},
): EventActions {
  const decoded = toJsonValue(loadPickle(data, createResolver(options)), 0);
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new Error(
      `A legacy pickled "events.actions" value decoded to ${describe(decoded)}, not an object.`,
    );
  }
  // The decoded fields are adk-python's snake_case shape, which is the same
  // shape the v1 `event_data` column holds, so the repository's own event
  // transform converts it and preserves the user-data keys.
  const {actions} = transformToCamelCaseEvent({actions: decoded});
  return createEventActions(actions);
}
