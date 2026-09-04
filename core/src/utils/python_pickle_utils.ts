/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PickleError,
  PickleErrorCode,
  PickleObjectFactory,
} from './pickle_utils.js';

/**
 * Factories for the Python builtin and standard-library types a pickle
 * payload can name.
 *
 * A caller composes these into its own allowlist, so a payload that names
 * `datetime.datetime` gets a `Date` and a payload that names anything absent
 * from the map is refused. Every factory here builds plain data from the
 * arguments the payload supplied; none of them runs the Python callable the
 * global stands for.
 *
 * The set matches `_STATIC_ALLOWED_GLOBALS` in adk-python's
 * `src/google/adk/sessions/_restricted_pickle.py`.
 */

/** Milliseconds in a day, for a `datetime.timedelta`. */
const MS_PER_DAY = 86_400_000;
const MS_PER_SECOND = 1_000;
const US_PER_MS = 1_000;

/** The byte counts of the packed states of the `datetime` types. */
const DATE_STATE_BYTES = 4;
const TIME_STATE_BYTES = 6;
const DATETIME_STATE_BYTES = 10;

/** The bit CPython sets in a packed state to mark an ambiguous local time. */
const FOLD_BIT = 0x80;

/** The digit count of a `uuid.UUID` written in hexadecimal. */
const UUID_HEX_DIGITS = 32;

/** The offsets the hyphens sit at in a canonical `uuid.UUID` string. */
const UUID_GROUP_OFFSETS = [8, 12, 16, 20];

function fail(message: string): never {
  throw new PickleError(PickleErrorCode.UNSUPPORTED_TARGET, message);
}

function packedState(args: readonly unknown[], length: number): Uint8Array {
  const state = args[0];
  if (!(state instanceof Uint8Array) || state.length !== length) {
    return fail(
      `A pickled datetime value needs a packed state of ${length} bytes.`,
    );
  }
  return state;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return fail('A pickled numeric value must be an int or a float.');
}

function toText(value: unknown): string {
  if (typeof value !== 'string') {
    return fail('A pickled text value must be a str.');
  }
  return value;
}

function toIterable(value: unknown): Iterable<unknown> {
  if (Array.isArray(value) || value instanceof Set) {
    return value;
  }
  if (value instanceof Map) {
    return value.keys();
  }
  return fail('A pickled container must be built from a list, tuple or set.');
}

/** Reads the 3-byte big-endian microsecond field of a packed datetime state. */
function microseconds(state: Uint8Array, offset: number): number {
  return (state[offset] << 16) | (state[offset + 1] << 8) | state[offset + 2];
}

function padded(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Builds the `Date` a `datetime.datetime` state stands for.
 *
 * A naive value — one the payload wrote with no `tzinfo` — is read as UTC, the
 * same reading adk-python's `StorageSession.get_update_timestamp` applies to a
 * naive column value.
 */
function toDate(state: Uint8Array, offsetMs: number): number {
  const year = (state[0] << 8) | state[1];
  const month = state[2] & ~FOLD_BIT;
  return (
    Date.UTC(
      year,
      month - 1,
      state[3],
      state[4],
      state[5],
      state[6],
      microseconds(state, 7) / US_PER_MS,
    ) - offsetMs
  );
}

/** A container or primitive that rebuilds from its single argument. */
function fromFirstArgument(
  build: (argument: unknown) => unknown,
  empty: () => unknown,
): PickleObjectFactory {
  return {create: (args) => (args.length === 0 ? empty() : build(args[0]))};
}

const DICT_FACTORY: PickleObjectFactory = {
  create: (args) =>
    args.length === 0
      ? new Map<unknown, unknown>()
      : new Map(toEntries(args[0])),
};

function toEntries(value: unknown): Iterable<[unknown, unknown]> {
  if (value instanceof Map) {
    return value;
  }
  return fail('A pickled dict must be built from another dict.');
}

/**
 * The `uuid.UUID` factory, which reads the integer a `BUILD` state carries and
 * renders the canonical hyphenated form.
 */
const UUID_FACTORY: PickleObjectFactory = {
  create: () => new Map<unknown, unknown>(),
  setState: (_instance, state) => {
    if (!(state instanceof Map)) {
      return fail('A pickled uuid.UUID needs a dictionary state.');
    }
    const value = state.get('int');
    if (typeof value !== 'bigint' && typeof value !== 'number') {
      return fail('A pickled uuid.UUID needs an int state.');
    }
    const digits = BigInt(value).toString(16).padStart(UUID_HEX_DIGITS, '0');
    let text = '';
    for (let index = 0; index < UUID_HEX_DIGITS; index++) {
      if (UUID_GROUP_OFFSETS.includes(index)) {
        text += '-';
      }
      text += digits[index];
    }
    return text;
  },
};

/**
 * The builtin and standard-library globals a payload may name, and the plain
 * JavaScript value each one builds.
 *
 * | Python | JavaScript |
 * | --- | --- |
 * | `dict`, `OrderedDict`, `defaultdict` | `Map` |
 * | `list`, `tuple` | `Array` |
 * | `set` | `Set` |
 * | `str`, `int`, `float`, `bool` | the argument, coerced |
 * | `bytes`, `bytearray` | `Uint8Array` |
 * | `complex` | `{real, imag}` |
 * | `datetime`, `date` | `Date` |
 * | `time` | `'HH:MM:SS.ffffff'` |
 * | `timedelta`, `timezone` | milliseconds |
 * | `Decimal`, `UUID`, the `pathlib` classes | `string` |
 *
 * A `defaultdict` drops its default factory, which Python only stores and
 * never calls while loading. The factory is still a global the payload names,
 * so it still has to pass the caller's allowlist.
 */
export const PYTHON_STDLIB_PICKLE_FACTORIES: ReadonlyMap<
  string,
  PickleObjectFactory
> = new Map<string, PickleObjectFactory>([
  ['builtins.dict', DICT_FACTORY],
  [
    'builtins.list',
    fromFirstArgument(
      (a) => [...toIterable(a)],
      () => [],
    ),
  ],
  [
    'builtins.tuple',
    fromFirstArgument(
      (a) => [...toIterable(a)],
      () => [],
    ),
  ],
  [
    'builtins.set',
    fromFirstArgument(
      (a) => new Set(toIterable(a)),
      () => new Set(),
    ),
  ],
  [
    'builtins.str',
    fromFirstArgument(
      (a) => String(a),
      () => '',
    ),
  ],
  ['builtins.int', fromFirstArgument(toNumber, () => 0)],
  ['builtins.float', fromFirstArgument(toNumber, () => 0)],
  [
    'builtins.bool',
    fromFirstArgument(
      (a) => Boolean(a),
      () => false,
    ),
  ],
  [
    'builtins.bytes',
    fromFirstArgument(
      (a) =>
        a instanceof Uint8Array
          ? a
          : fail('A pickled bytes value must be bytes.'),
      () => new Uint8Array(0),
    ),
  ],
  [
    'builtins.bytearray',
    fromFirstArgument(
      (a) =>
        a instanceof Uint8Array
          ? a
          : fail('A pickled bytearray value must be bytes.'),
      () => new Uint8Array(0),
    ),
  ],
  [
    'builtins.complex',
    {create: (args) => ({real: toNumber(args[0]), imag: toNumber(args[1])})},
  ],
  ['collections.OrderedDict', DICT_FACTORY],
  // `defaultdict(factory)` passes its factory as the single argument.
  ['collections.defaultdict', {create: () => new Map<unknown, unknown>()}],
  [
    'datetime.date',
    {
      create: (args) => {
        const state = packedState(args, DATE_STATE_BYTES);
        return new Date(
          Date.UTC((state[0] << 8) | state[1], state[2] - 1, state[3]),
        );
      },
    },
  ],
  [
    'datetime.datetime',
    {
      create: (args) => {
        const state = packedState(args, DATETIME_STATE_BYTES);
        const offsetMs = args.length > 1 ? toNumber(args[1]) : 0;
        return new Date(toDate(state, offsetMs));
      },
    },
  ],
  [
    'datetime.time',
    {
      create: (args) => {
        const state = packedState(args, TIME_STATE_BYTES);
        const hour = state[0] & ~FOLD_BIT;
        const fraction = padded(microseconds(state, 3), 6);
        return (
          `${padded(hour, 2)}:${padded(state[1], 2)}:` +
          `${padded(state[2], 2)}.${fraction}`
        );
      },
    },
  ],
  [
    'datetime.timedelta',
    {
      create: (args) =>
        toNumber(args[0]) * MS_PER_DAY +
        toNumber(args[1]) * MS_PER_SECOND +
        toNumber(args[2]) / US_PER_MS,
    },
  ],
  // `timezone(offset)` and `timezone(offset, name)` both carry the offset
  // first, already reduced to milliseconds by the `timedelta` factory.
  ['datetime.timezone', {create: (args) => toNumber(args[0])}],
  ['decimal.Decimal', {create: (args) => toText(args[0])}],
  ['uuid.UUID', UUID_FACTORY],
  ...pathFactories(),
]);

/**
 * The `pathlib` classes, under both module names.
 *
 * Python 3.13 moved the concrete classes into a private submodule, and a
 * payload names whichever module the interpreter that wrote it recorded.
 */
function pathFactories(): Array<[string, PickleObjectFactory]> {
  const classNames = [
    'PurePosixPath',
    'PureWindowsPath',
    'PosixPath',
    'WindowsPath',
  ];
  const separators: Record<string, string> = {
    PurePosixPath: '/',
    PosixPath: '/',
    PureWindowsPath: '\\',
    WindowsPath: '\\',
  };
  const factories: Array<[string, PickleObjectFactory]> = [];
  for (const moduleName of ['pathlib', 'pathlib._local']) {
    for (const className of classNames) {
      factories.push([
        `${moduleName}.${className}`,
        {
          create: (args) => args.map(toText).join(separators[className]) || '.',
        },
      ]);
    }
  }
  return factories;
}

/**
 * Converts a value `loadPickle` produced into plain JavaScript data.
 *
 * A Python `dict` arrives as a `Map` and a `set` as a `Set`, neither of which
 * survives `JSON.stringify`. Session state has to, so a `Map` becomes an
 * object and a `Set` becomes an array. A `Map` key that is not a string
 * becomes its `String` form, the only key an object can hold.
 */
export function pickleToPlain(value: unknown): unknown {
  if (value instanceof Map) {
    const plain: Record<string, unknown> = {};
    for (const [key, element] of value) {
      plain[typeof key === 'string' ? key : String(key)] =
        pickleToPlain(element);
    }
    return plain;
  }
  if (value instanceof Set) {
    return [...value].map(pickleToPlain);
  }
  if (Array.isArray(value)) {
    return value.map(pickleToPlain);
  }
  return value;
}

/**
 * Converts plain JavaScript data into the value `dumpPickle` writes.
 *
 * An object becomes a `Map`, so Python reads a `dict` rather than an instance
 * of some class. `undefined` and a `Date` follow `JSON.stringify`: a property
 * whose value is `undefined` is dropped, an element becomes `null`, and a
 * `Date` becomes its ISO string. Session state already has to survive
 * `JSON.stringify` on the v1 schema, so this loses nothing the current schema
 * keeps.
 */
export function plainToPickle(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(plainToPickle);
  }
  if (
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = new Map<unknown, unknown>();
    for (const [key, element] of Object.entries(value)) {
      if (element !== undefined) {
        entries.set(key, plainToPickle(element));
      }
    }
    return entries;
  }
  return value;
}
