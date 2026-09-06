/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reads the pickled `events.actions` blobs written by the v0 session schema.
 *
 * The v0 schema stored `EventActions` as a Python pickle, so bytes read back
 * from such a database are untrusted input. This reader is a stack machine
 * over the pickle opcodes: it resolves a class name to a plain record and
 * never calls anything the payload names. Python's own unpickler can be made
 * to call an arbitrary callable through `REDUCE`; there is no equivalent here
 * and none is to be added.
 *
 * Mirrors `google/adk-python` `src/google/adk/sessions/_restricted_pickle.py`.
 */

/** Raised when a payload is malformed, truncated, or names a refused class. */
export class UnpicklingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnpicklingError';
  }
}

const PYTHON_OBJECT_SIGNATURE = Symbol.for('google.adk.pickle.pythonObject');
const PYTHON_CLASS_KIND = Symbol.for('google.adk.pickle.classKind');

/**
 * A Python object the reader reconstructed but has no JavaScript analogue for.
 *
 * Holding one is inert: it records the class name the payload asked for and
 * the instance attributes it carried, and nothing more.
 */
export interface PythonObject {
  readonly [PYTHON_OBJECT_SIGNATURE]: true;
  /** Fully qualified Python class, e.g. `google.adk.events.event_actions.EventActions`. */
  readonly pyClass: string;
  /** Instance attributes, i.e. the payload's `__dict__`. */
  readonly attributes: {[key: string]: PickleValue};
}

/**
 * A value decoded from a pickle payload.
 *
 * A Python dict decodes to a `Map` rather than a plain object, because pickle
 * dict keys are arbitrary hashable values and a plain object would collapse
 * `1` and `'1'` onto one key. The only string-keyed record here is
 * {@link PythonObject.attributes}, which pickle guarantees is string-keyed.
 */
export type PickleValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | Date
  | PickleValue[]
  | Set<PickleValue>
  | Map<PickleValue, PickleValue>
  | PythonObject;

/** Options for {@link loadsRestricted}. */
export interface UnpickleOptions {
  /**
   * Resolve any global instead of only the allowlisted ones. The reader never
   * executes code in either mode; this only widens which class names may
   * appear. Mirrors adk-python's `allow_unsafe_unpickling`.
   */
  allowUnknownGlobals?: boolean;
}

/** How the reader reconstructs the value a resolved class stands for. */
type PythonClassKind =
  | 'map'
  | 'list'
  | 'set'
  | 'scalar'
  | 'datetime'
  | 'date'
  | 'time'
  | 'timedelta'
  | 'timezone'
  | 'text'
  | 'newFromClassArg'
  | 'model'
  | 'opaque';

/** A resolved class handle. It is a {@link PythonObject} that carries its kind. */
interface PythonClass extends PythonObject {
  readonly [PYTHON_CLASS_KIND]: PythonClassKind;
}

/**
 * The globals the reader resolves by exact name.
 *
 * Mirrors `_STATIC_ALLOWED_GLOBALS` in adk-python's `_restricted_pickle.py`.
 * Every entry is an inert data type: resolving one builds a container, a
 * scalar, a date or a plain record.
 */
const ALLOWED_GLOBALS: ReadonlyMap<string, PythonClassKind> = new Map<
  string,
  PythonClassKind
>([
  ['builtins.dict', 'map'],
  ['builtins.list', 'list'],
  ['builtins.tuple', 'list'],
  ['builtins.set', 'set'],
  ['builtins.frozenset', 'set'],
  ['builtins.str', 'scalar'],
  ['builtins.bytes', 'scalar'],
  ['builtins.bytearray', 'scalar'],
  ['builtins.int', 'scalar'],
  ['builtins.float', 'scalar'],
  ['builtins.bool', 'scalar'],
  ['builtins.complex', 'scalar'],
  ['builtins.object', 'opaque'],
  ['collections.OrderedDict', 'map'],
  ['collections.defaultdict', 'map'],
  ['copyreg._reconstructor', 'newFromClassArg'],
  ['copyreg.__newobj__', 'newFromClassArg'],
  // Protocol 2 records the Python 2 module names for these, whichever
  // interpreter wrote the payload.
  ['__builtin__.object', 'opaque'],
  ['__builtin__.set', 'set'],
  ['__builtin__.frozenset', 'set'],
  ['copy_reg._reconstructor', 'newFromClassArg'],
  ['datetime.date', 'date'],
  ['datetime.datetime', 'datetime'],
  ['datetime.time', 'time'],
  ['datetime.timedelta', 'timedelta'],
  ['datetime.timezone', 'timezone'],
  ['decimal.Decimal', 'text'],
  ['uuid.UUID', 'opaque'],
  ['pathlib.PurePosixPath', 'text'],
  ['pathlib.PureWindowsPath', 'text'],
  ['pathlib.PosixPath', 'text'],
  ['pathlib.WindowsPath', 'text'],
  // Python 3.13 moved the concrete pathlib classes into a private submodule,
  // and a payload names whichever module the interpreter that wrote it saw.
  ['pathlib._local.PurePosixPath', 'text'],
  ['pathlib._local.PureWindowsPath', 'text'],
  ['pathlib._local.PosixPath', 'text'],
  ['pathlib._local.WindowsPath', 'text'],
]);

/**
 * Module prefixes whose classes resolve to a {@link PythonObject}.
 *
 * adk-python derives its model set by walking Pydantic annotations at runtime.
 * TypeScript has no equivalent reflection over the Python model tree, so these
 * modules are admitted by prefix instead. That is broader than the derived
 * set, and safe here because resolving a name only builds a plain record: the
 * blast radius of admitting one is a wrong field name, not code execution.
 */
const ALLOWED_MODULE_PREFIXES = [
  'google.adk.',
  'google.genai.',
  'fastapi.openapi.models',
  'pydantic',
];

/** Pydantic writes these alongside `__dict__`; they are not model fields. */
const PYDANTIC_STATE_KEYS = new Set([
  '__pydantic_extra__',
  '__pydantic_fields_set__',
  '__pydantic_private__',
]);

/** The instance dictionary key in a pickled Pydantic model's state. */
const INSTANCE_DICT_KEY = '__dict__';

/** The highest pickle protocol this reader accepts. */
const MAX_PROTOCOL = 5;

/** Pickle opcodes, protocol 2 through 5. */
const OP = {
  MARK: 0x28,
  STOP: 0x2e,
  BINBYTES: 0x42,
  SHORT_BINBYTES: 0x43,
  BINFLOAT: 0x47,
  BININT: 0x4a,
  BININT1: 0x4b,
  BININT2: 0x4d,
  NONE: 0x4e,
  REDUCE: 0x52,
  BINUNICODE: 0x58,
  EMPTY_TUPLE: 0x29,
  EMPTY_LIST: 0x5d,
  APPEND: 0x61,
  BUILD: 0x62,
  GLOBAL: 0x63,
  DICT: 0x64,
  APPENDS: 0x65,
  BINGET: 0x68,
  LIST: 0x6c,
  LONG_BINGET: 0x6a,
  BINPUT: 0x71,
  LONG_BINPUT: 0x72,
  SETITEM: 0x73,
  TUPLE: 0x74,
  SETITEMS: 0x75,
  EMPTY_DICT: 0x7d,
  PROTO: 0x80,
  NEWOBJ: 0x81,
  TUPLE1: 0x85,
  TUPLE2: 0x86,
  TUPLE3: 0x87,
  NEWTRUE: 0x88,
  NEWFALSE: 0x89,
  LONG1: 0x8a,
  LONG4: 0x8b,
  SHORT_BINUNICODE: 0x8c,
  BINUNICODE8: 0x8d,
  BINBYTES8: 0x8e,
  EMPTY_SET: 0x8f,
  ADDITEMS: 0x90,
  FROZENSET: 0x91,
  NEWOBJ_EX: 0x92,
  STACK_GLOBAL: 0x93,
  MEMOIZE: 0x94,
  FRAME: 0x95,
} as const;

/** Returns whether the value is a class or object record the reader built. */
export function isPythonObject(value: PickleValue): value is PythonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    PYTHON_OBJECT_SIGNATURE in value
  );
}

function makePythonObject(
  pyClass: string,
  attributes: {[key: string]: PickleValue} = {},
): PythonObject {
  return {[PYTHON_OBJECT_SIGNATURE]: true, pyClass, attributes};
}

function makePythonClass(pyClass: string, kind: PythonClassKind): PythonClass {
  return {...makePythonObject(pyClass), [PYTHON_CLASS_KIND]: kind};
}

function classKindOf(value: PickleValue): PythonClassKind | undefined {
  return isPythonObject(value) && PYTHON_CLASS_KIND in value
    ? (value as PythonClass)[PYTHON_CLASS_KIND]
    : undefined;
}

/** Resolves `<module>.<name>` to a class handle, or refuses it. */
function resolveGlobal(
  module: string,
  name: string,
  allowUnknownGlobals: boolean,
): PythonClass {
  const pyClass = `${module}.${name}`;
  const known = ALLOWED_GLOBALS.get(pyClass);
  if (known) {
    return makePythonClass(pyClass, known);
  }
  if (ALLOWED_MODULE_PREFIXES.some((prefix) => module.startsWith(prefix))) {
    return makePythonClass(pyClass, 'model');
  }
  if (allowUnknownGlobals) {
    return makePythonClass(pyClass, 'opaque');
  }
  throw new UnpicklingError(
    `Refusing to load ${pyClass} from a legacy pickled 'events.actions' ` +
      'value: it is not a type that EventActions can hold. This value was ' +
      'either not written by ADK, or it holds session state that is not ' +
      'plain data. To recover a database whose contents you trust, migrate ' +
      'it with allowUnsafeUnpickling.',
  );
}

/** The seven fields of a Python `datetime`, already widened to milliseconds. */
interface DatetimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/**
 * Decodes the packed byte state Python writes for a `date` (four bytes) or a
 * `datetime` (ten), reading the fields a `date` omits as zero.
 */
function datetimePartsOf(state: Uint8Array): DatetimeParts {
  const at = (index: number) => state[index] ?? 0;
  const microseconds = (at(7) << 16) | (at(8) << 8) | at(9);
  return {
    year: (at(0) << 8) | at(1),
    month: at(2),
    day: at(3),
    hour: at(4),
    minute: at(5),
    second: at(6),
    millisecond: Math.floor(microseconds / 1000),
  };
}

/**
 * Builds a `Date` from calendar fields in the host's local zone.
 *
 * `new Date(year, ...)` maps a year below 100 onto 1900 + year; setting the
 * fields on an epoch `Date` does not.
 */
function localDateOf(parts: DatetimeParts): Date {
  const date = new Date(0);
  date.setFullYear(parts.year, parts.month - 1, parts.day);
  date.setHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return date;
}

/** Builds a `Date` from calendar fields read as UTC. */
function utcDateOf(parts: DatetimeParts): Date {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return date;
}

function toBytes(value: PickleValue): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new UnpicklingError(
      'Expected a packed byte state for a datetime value.',
    );
  }
  return value;
}

/**
 * Reconstructs a `datetime`, whose second argument is its `tzinfo` when the
 * value is timezone aware. A naive value is local time, matching how the v0
 * writer produced it.
 */
function reconstructDatetime(args: PickleValue[]): Date {
  const parts = datetimePartsOf(toBytes(args[0]));
  const offsetMinutes = args[1];
  if (typeof offsetMinutes !== 'number') {
    return localDateOf(parts);
  }
  return new Date(utcDateOf(parts).getTime() - offsetMinutes * 60_000);
}

/** Formats a Python `time` as `HH:MM:SS.mmm`, matching its JSON form. */
function reconstructTime(args: PickleValue[]): string {
  const state = toBytes(args[0]);
  const microseconds = (state[3] << 16) | (state[4] << 8) | state[5];
  const pad = (value: number, width: number) =>
    String(value).padStart(width, '0');
  return (
    `${pad(state[0], 2)}:${pad(state[1], 2)}:${pad(state[2], 2)}` +
    `.${pad(Math.floor(microseconds / 1000), 3)}`
  );
}

/** Reconstructs a `timedelta(days, seconds, microseconds)` as milliseconds. */
function reconstructTimedelta(args: PickleValue[]): number {
  const field = (index: number) =>
    typeof args[index] === 'number' ? (args[index] as number) : 0;
  return field(0) * 86_400_000 + field(1) * 1000 + Math.floor(field(2) / 1000);
}

/** Reconstructs a `timezone(timedelta)` as an offset in minutes. */
function reconstructTimezone(args: PickleValue[]): number {
  return typeof args[0] === 'number' ? args[0] / 60_000 : 0;
}

/**
 * Reconstructs an object from a plumbing global that takes the real class as
 * its first argument, i.e. `copyreg._reconstructor` and `copyreg.__newobj__`.
 */
function reconstructFromClassArg(
  pyClass: string,
  args: PickleValue[],
): PythonObject {
  const target = args[0];
  return isPythonObject(target)
    ? makePythonObject(target.pyClass)
    : makePythonObject(pyClass);
}

/**
 * Reconstructs a model class. `REDUCE(EnumClass, [value])` is what a
 * string-valued enum member pickles as, and its bare value is what
 * `model_dump(mode="json")` would have written. `NEWOBJ` never carries that
 * shape, so `construct` tells the two apart.
 */
function reconstructModel(
  pyClass: string,
  args: PickleValue[],
  construct: boolean,
): PickleValue {
  if (!construct && args.length === 1 && typeof args[0] === 'string') {
    return args[0];
  }
  return makePythonObject(pyClass);
}

function toSet(value: PickleValue): Set<PickleValue> {
  return new Set(Array.isArray(value) ? value : []);
}

/**
 * Applies `REDUCE` / `NEWOBJ` semantics for a resolved class.
 *
 * @param construct Whether the opcode was `NEWOBJ` or `NEWOBJ_EX`.
 */
function instantiate(
  handle: PythonObject,
  args: PickleValue[],
  construct: boolean,
): PickleValue {
  const kind = classKindOf(handle);
  const pyClass = handle.pyClass;
  switch (kind) {
    case 'map':
      return new Map<PickleValue, PickleValue>();
    case 'list':
      return [];
    case 'set':
      return toSet(args[0]);
    case 'scalar':
      return args[0] ?? null;
    case 'datetime':
      return reconstructDatetime(args);
    case 'date':
      return localDateOf(datetimePartsOf(toBytes(args[0])));
    case 'time':
      return reconstructTime(args);
    case 'timedelta':
      return reconstructTimedelta(args);
    case 'timezone':
      return reconstructTimezone(args);
    case 'text':
      return args
        .filter((arg): arg is string => typeof arg === 'string')
        .join('/');
    case 'newFromClassArg':
      return reconstructFromClassArg(pyClass, args);
    case 'model':
      return reconstructModel(pyClass, args, construct);
    default:
      return makePythonObject(pyClass);
  }
}

/**
 * Applies `BUILD` state to a reconstructed object.
 *
 * A Pydantic model nests its fields under `__dict__` and carries three private
 * bookkeeping keys beside it; any other object states its attributes directly.
 */
function applyState(target: PythonObject, state: PickleValue): void {
  if (!(state instanceof Map)) {
    return;
  }
  const instanceDict = state.get(INSTANCE_DICT_KEY);
  const fields = instanceDict instanceof Map ? instanceDict : state;
  for (const [key, value] of fields) {
    if (typeof key === 'string' && !PYDANTIC_STATE_KEYS.has(key)) {
      target.attributes[key] = value;
    }
  }
}

/** A pickle stack machine that resolves class names but never calls them. */
class PickleReader {
  private position = 0;
  private stack: PickleValue[] = [];
  private readonly frames: PickleValue[][] = [];
  private readonly memo = new Map<number, PickleValue>();
  private readonly view: DataView;
  private readonly decoder = new TextDecoder('utf-8', {fatal: true});

  constructor(
    private readonly data: Uint8Array,
    private readonly allowUnknownGlobals: boolean,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  load(): PickleValue {
    for (;;) {
      const opcode = this.readByte();
      if (opcode === OP.STOP) {
        return this.pop();
      }
      this.step(opcode);
    }
  }

  private step(opcode: number): void {
    switch (opcode) {
      case OP.PROTO:
        return this.readProtocol();
      case OP.FRAME:
        this.advance(8);
        return;
      case OP.MARK:
        return this.pushMark();
      case OP.MEMOIZE:
        return this.memoize(this.memo.size);
      case OP.BINPUT:
        return this.memoize(this.readByte());
      case OP.LONG_BINPUT:
        return this.memoize(this.readUint32());
      case OP.BINGET:
        return this.push(this.readMemo(this.readByte()));
      case OP.LONG_BINGET:
        return this.push(this.readMemo(this.readUint32()));
      case OP.NONE:
        return this.push(null);
      case OP.NEWTRUE:
        return this.push(true);
      case OP.NEWFALSE:
        return this.push(false);
      case OP.BININT:
        return this.push(this.readInt32());
      case OP.BININT1:
        return this.push(this.readByte());
      case OP.BININT2:
        return this.push(this.readUint16());
      case OP.LONG1:
        return this.push(this.readLong(this.readByte()));
      case OP.LONG4:
        return this.push(this.readLong(this.readInt32()));
      case OP.BINFLOAT:
        return this.push(this.readFloat64());
      case OP.SHORT_BINUNICODE:
        return this.push(this.readString(this.readByte()));
      case OP.BINUNICODE:
        return this.push(this.readString(this.readUint32()));
      case OP.BINUNICODE8:
        return this.push(this.readString(this.readUint64()));
      case OP.SHORT_BINBYTES:
        return this.push(this.readBytes(this.readByte()));
      case OP.BINBYTES:
        return this.push(this.readBytes(this.readUint32()));
      case OP.BINBYTES8:
        return this.push(this.readBytes(this.readUint64()));
      case OP.EMPTY_DICT:
        return this.push(new Map<PickleValue, PickleValue>());
      case OP.DICT:
        return this.push(mapOfPairs(this.popMark()));
      case OP.SETITEM:
        return this.setItems(this.popCount(2));
      case OP.SETITEMS:
        return this.setItems(this.popMark());
      case OP.EMPTY_LIST:
      case OP.EMPTY_TUPLE:
        return this.push([]);
      case OP.LIST:
      case OP.TUPLE:
        return this.push(this.popMark());
      case OP.APPEND:
        return this.appendItems(this.popCount(1));
      case OP.APPENDS:
        return this.appendItems(this.popMark());
      case OP.TUPLE1:
        return this.push(this.popCount(1));
      case OP.TUPLE2:
        return this.push(this.popCount(2));
      case OP.TUPLE3:
        return this.push(this.popCount(3));
      case OP.EMPTY_SET:
        return this.push(new Set<PickleValue>());
      case OP.FROZENSET:
        return this.push(new Set(this.popMark()));
      case OP.ADDITEMS:
        return this.addItems(this.popMark());
      case OP.GLOBAL:
        return this.push(this.resolve(this.readLine(), this.readLine()));
      case OP.STACK_GLOBAL:
        return this.pushStackGlobal();
      case OP.REDUCE:
        return this.reduce(2, false);
      case OP.NEWOBJ:
        return this.reduce(2, true);
      case OP.NEWOBJ_EX:
        return this.reduce(3, true);
      case OP.BUILD:
        return this.build();
      default:
        throw new UnpicklingError(
          `Unsupported pickle opcode 0x${opcode.toString(16)} at byte ${
            this.position - 1
          }.`,
        );
    }
  }

  private push(value: PickleValue): void {
    this.stack.push(value);
  }

  private pushMark(): void {
    this.frames.push(this.stack);
    this.stack = [];
  }

  private memoize(index: number): void {
    this.memo.set(index, this.peek());
  }

  private readProtocol(): void {
    const protocol = this.readByte();
    if (protocol > MAX_PROTOCOL) {
      throw new UnpicklingError(`Unsupported pickle protocol ${protocol}.`);
    }
  }

  private resolve(module: string, name: string): PickleValue {
    return resolveGlobal(module, name, this.allowUnknownGlobals);
  }

  private pushStackGlobal(): void {
    const [module, name] = this.popCount(2);
    if (typeof module !== 'string' || typeof name !== 'string') {
      throw new UnpicklingError('STACK_GLOBAL expects two strings.');
    }
    this.push(this.resolve(module, name));
  }

  /**
   * Applies `REDUCE`, `NEWOBJ` (two operands) or `NEWOBJ_EX` (three, the third
   * being the keyword dict this reader has no use for).
   */
  private reduce(operands: number, construct: boolean): void {
    const [handle, args] = this.popCount(operands);
    if (!isPythonObject(handle) || !Array.isArray(args)) {
      throw new UnpicklingError('REDUCE expects a class and an argument list.');
    }
    this.push(instantiate(handle, args, construct));
  }

  private build(): void {
    const [target, state] = this.popCount(2);
    if (!isPythonObject(target)) {
      throw new UnpicklingError('BUILD expects an object to apply state to.');
    }
    applyState(target, state);
    this.push(target);
  }

  private setItems(items: PickleValue[]): void {
    const target = this.peek();
    if (!(target instanceof Map)) {
      throw new UnpicklingError('SETITEM expects a dict on the stack.');
    }
    for (let index = 0; index + 1 < items.length; index += 2) {
      target.set(items[index], items[index + 1]);
    }
  }

  private appendItems(items: PickleValue[]): void {
    const target = this.peek();
    if (!Array.isArray(target)) {
      throw new UnpicklingError('APPEND expects a list on the stack.');
    }
    target.push(...items);
  }

  private addItems(items: PickleValue[]): void {
    const target = this.peek();
    if (!(target instanceof Set)) {
      throw new UnpicklingError('ADDITEMS expects a set on the stack.');
    }
    for (const item of items) {
      target.add(item);
    }
  }

  /** Pops everything pushed since the matching `MARK`. */
  private popMark(): PickleValue[] {
    const marked = this.stack;
    const enclosing = this.frames.pop();
    if (!enclosing) {
      throw new UnpicklingError('Found an opcode with no matching MARK.');
    }
    this.stack = enclosing;
    return marked;
  }

  private popCount(count: number): PickleValue[] {
    if (this.stack.length < count) {
      throw new UnpicklingError(
        `A pickle opcode needed ${count} stack values but found ${this.stack.length}.`,
      );
    }
    return this.stack.splice(this.stack.length - count, count);
  }

  private pop(): PickleValue {
    return this.popCount(1)[0];
  }

  private peek(): PickleValue {
    if (this.stack.length === 0) {
      throw new UnpicklingError('A pickle opcode read an empty stack.');
    }
    return this.stack[this.stack.length - 1];
  }

  private readMemo(index: number): PickleValue {
    if (!this.memo.has(index)) {
      throw new UnpicklingError(
        `Memo slot ${index} was read before it was written.`,
      );
    }
    return this.memo.get(index) as PickleValue;
  }

  /** Advances the cursor by `count` bytes, refusing to run past the end. */
  private advance(count: number): number {
    const start = this.position;
    if (count < 0 || start + count > this.data.length) {
      throw new UnpicklingError('The pickle payload ended unexpectedly.');
    }
    this.position = start + count;
    return start;
  }

  private readByte(): number {
    return this.data[this.advance(1)];
  }

  private readUint16(): number {
    return this.view.getUint16(this.advance(2), true);
  }

  private readUint32(): number {
    return this.view.getUint32(this.advance(4), true);
  }

  private readInt32(): number {
    return this.view.getInt32(this.advance(4), true);
  }

  private readUint64(): number {
    const value = this.view.getBigUint64(this.advance(8), true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new UnpicklingError(
        'The pickle payload declares a length this reader cannot address.',
      );
    }
    return Number(value);
  }

  private readFloat64(): number {
    return this.view.getFloat64(this.advance(8), false);
  }

  private readBytes(length: number): Uint8Array {
    return this.data.slice(this.advance(length), this.position);
  }

  private readString(length: number): string {
    return this.decoder.decode(this.readBytes(length));
  }

  /** Reads a newline-terminated token, as the text-mode `GLOBAL` opcode uses. */
  private readLine(): string {
    const end = this.data.indexOf(0x0a, this.position);
    if (end === -1) {
      throw new UnpicklingError('The pickle payload ended unexpectedly.');
    }
    const line = this.readString(end - this.position);
    this.advance(1);
    return line;
  }

  /** Reads a little-endian two's-complement integer of `length` bytes. */
  private readLong(length: number): bigint | number {
    const bytes = this.readBytes(length);
    let value = 0n;
    for (let index = bytes.length - 1; index >= 0; index--) {
      value = (value << 8n) | BigInt(bytes[index]);
    }
    if (bytes.length > 0 && bytes[bytes.length - 1] >= 0x80) {
      value -= 1n << BigInt(8 * bytes.length);
    }
    return value;
  }
}

function mapOfPairs(items: PickleValue[]): Map<PickleValue, PickleValue> {
  const target = new Map<PickleValue, PickleValue>();
  for (let index = 0; index + 1 < items.length; index += 2) {
    target.set(items[index], items[index + 1]);
  }
  return target;
}

/**
 * Decodes a pickle payload written by the v0 session schema.
 *
 * @param data The raw bytes of the `events.actions` column.
 * @param options Reader options.
 * @returns The decoded value.
 * @throws {UnpicklingError} If the payload is malformed or names a refused class.
 */
export function loadsRestricted(
  data: Uint8Array,
  options: UnpickleOptions = {},
): PickleValue {
  return new PickleReader(data, options.allowUnknownGlobals ?? false).load();
}

/** A value that survives `JSON.stringify` unchanged. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {[key: string]: JsonValue};

function jsonKeyOf(key: PickleValue): string {
  return typeof key === 'string' ? key : String(pickleToJson(key));
}

function jsonRecordOf(entries: Iterable<[PickleValue, PickleValue]>): {
  [key: string]: JsonValue;
} {
  const record: {[key: string]: JsonValue} = {};
  for (const [key, value] of entries) {
    record[jsonKeyOf(key)] = pickleToJson(value);
  }
  return record;
}

/**
 * Converts a reconstructed Python object into its JSON form, i.e. a record of
 * its instance attributes.
 */
export function pythonObjectToJson(object: PythonObject): {
  [key: string]: JsonValue;
} {
  return jsonRecordOf(Object.entries(object.attributes));
}

/**
 * Converts a decoded pickle value into the JSON form the v1 `event_data`
 * column holds, matching what Python's `model_dump(mode="json")` emits for the
 * same value.
 */
export function pickleToJson(value: PickleValue): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(pickleToJson);
  }
  if (value instanceof Set) {
    return [...value].map(pickleToJson);
  }
  if (value instanceof Map) {
    return jsonRecordOf(value);
  }
  return pythonObjectToJson(value);
}
