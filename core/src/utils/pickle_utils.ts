/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A restricted reader and writer for the Python pickle format.
 *
 * Python's own unpickler resolves whatever global a payload names and calls
 * it, which turns an untrusted payload into arbitrary code. {@link loadPickle}
 * executes nothing: it hands every global to a resolver the caller supplies,
 * so a payload can only build the values that resolver agreed to build.
 *
 * The reader accepts the opcodes CPython emits for plain data and for a
 * pydantic v2 model at protocols 2 to 5, and refuses every other opcode by
 * name. The writer emits protocol 4 only.
 */

/** Why a payload was rejected. */
export enum PickleErrorCode {
  /** The payload uses an opcode this reader does not implement. */
  UNSUPPORTED_OPCODE = 'unsupported_opcode',
  /** The payload ends in the middle of a value. */
  TRUNCATED_PAYLOAD = 'truncated_payload',
  /** The payload reads a memo slot it never wrote. */
  UNKNOWN_MEMO = 'unknown_memo',
  /** An opcode needs more stack entries than the payload pushed. */
  STACK_UNDERFLOW = 'stack_underflow',
  /** A `BUILD`, `SETITEM` or `APPEND` targets a value that cannot take it. */
  UNSUPPORTED_TARGET = 'unsupported_target',
  /** The writer was given a value the pickle format cannot hold. */
  UNSUPPORTED_VALUE = 'unsupported_value',
  /** The resolver refused the global the payload named. */
  REFUSED_GLOBAL = 'refused_global',
}

/** A malformed, unsupported or refused pickle payload. */
export class PickleError extends Error {
  constructor(
    readonly code: PickleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PickleError';
  }
}

/**
 * A payload named a global its resolver refuses.
 *
 * This is the security boundary: a refusal means the reader resolved nothing
 * and built nothing for that global.
 */
export class PickleSecurityError extends PickleError {
  constructor(message: string) {
    super(PickleErrorCode.REFUSED_GLOBAL, message);
    this.name = 'PickleSecurityError';
  }
}

/** A global a payload names, as `module.name`. */
export interface PickleGlobal {
  /** The module the payload resolves the value from. */
  module: string;
  /** The value's name within that module. */
  name: string;
}

/**
 * Builds the value an allowed global stands for.
 *
 * The reader calls this in place of the Python callable a payload names, for
 * `REDUCE`, `NEWOBJ` and `NEWOBJ_EX`.
 */
export interface PickleObjectFactory {
  /**
   * Builds the instance.
   *
   * @param args The positional arguments the payload passed.
   * @param kwargs The keyword arguments of `NEWOBJ_EX`; empty otherwise.
   */
  create(
    args: readonly unknown[],
    kwargs: ReadonlyMap<unknown, unknown>,
  ): unknown;

  /**
   * Applies a `BUILD` state to an instance and returns the result.
   *
   * Without it, a `BUILD` merges a dictionary state into an instance the
   * factory built as a `Map` — what Python's default `__dict__.update` does —
   * and fails for any other instance.
   *
   * Prefer mutating `instance` and returning it. CPython memoizes an instance
   * before its `BUILD`, and mutates it in place, so a payload can already hold
   * a reference to it — inside its own state, for a value that contains
   * itself. The reader re-points its memo when this returns something else,
   * which covers every reference the payload takes after the `BUILD`, but it
   * cannot reach one already stored inside another container.
   */
  setState?(instance: unknown, state: unknown): unknown;
}

/** Resolves an allowed global to a factory, or refuses it. */
export type PickleGlobalResolver = (
  pickleGlobal: PickleGlobal,
) => PickleObjectFactory;

/**
 * A value the writer rebuilds by naming a global and applying a state.
 *
 * This is how {@link dumpPickle} expresses an instance of a class. The reader
 * on the other side resolves {@link PickleInstance.global} through its own
 * allowlist before it builds anything.
 */
export interface PickleInstance {
  /** Marks this as an instance rather than the dictionary it resembles. */
  kind: 'pickle-instance';
  /** The class the payload names. */
  global: PickleGlobal;
  /** The arguments of `__new__`. */
  args: readonly unknown[];
  /** The state a `BUILD` applies to the new instance. */
  state: unknown;
}

/** Returns whether a value is a {@link PickleInstance}. */
export function isPickleInstance(value: unknown): value is PickleInstance {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as {kind?: unknown}).kind === 'pickle-instance'
  );
}

/**
 * Every pickle opcode, so a refusal can name the one it refused.
 *
 * The reader implements a subset; see {@link PickleReader.step}.
 */
const OPCODE = {
  BINBYTES: 0x42,
  SHORT_BINBYTES: 0x43,
  FLOAT: 0x46,
  BINFLOAT: 0x47,
  INT: 0x49,
  BININT: 0x4a,
  BININT1: 0x4b,
  LONG: 0x4c,
  BININT2: 0x4d,
  NONE: 0x4e,
  PERSID: 0x50,
  BINPERSID: 0x51,
  REDUCE: 0x52,
  STRING: 0x53,
  BINSTRING: 0x54,
  SHORT_BINSTRING: 0x55,
  UNICODE: 0x56,
  BINUNICODE: 0x58,
  MARK: 0x28,
  EMPTY_TUPLE: 0x29,
  STOP: 0x2e,
  POP: 0x30,
  POP_MARK: 0x31,
  DUP: 0x32,
  EMPTY_LIST: 0x5d,
  APPEND: 0x61,
  BUILD: 0x62,
  GLOBAL: 0x63,
  DICT: 0x64,
  APPENDS: 0x65,
  GET: 0x67,
  BINGET: 0x68,
  INST: 0x69,
  LONG_BINGET: 0x6a,
  LIST: 0x6c,
  OBJ: 0x6f,
  PUT: 0x70,
  BINPUT: 0x71,
  LONG_BINPUT: 0x72,
  SETITEM: 0x73,
  TUPLE: 0x74,
  SETITEMS: 0x75,
  EMPTY_DICT: 0x7d,
  PROTO: 0x80,
  NEWOBJ: 0x81,
  EXT1: 0x82,
  EXT2: 0x83,
  EXT4: 0x84,
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
  BYTEARRAY8: 0x96,
  NEXT_BUFFER: 0x97,
  READONLY_BUFFER: 0x98,
} as const;

const OPCODE_NAMES = new Map<number, string>(
  Object.entries(OPCODE).map(([name, code]) => [code, name]),
);

/** The protocol {@link dumpPickle} emits. */
const WRITER_PROTOCOL = 4;

/** The highest protocol {@link loadPickle} accepts. */
const MAX_READER_PROTOCOL = 5;

/** The exclusive upper bound of everything a single unsigned byte holds. */
const BYTE_LIMIT = 0x100;

/** The exclusive upper bound of a `BININT2` operand. */
const UINT16_LIMIT = 0x10000;

/** The bounds of the signed 32-bit operand `BININT` holds. */
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

/** The byte a text operand of `GLOBAL` ends with. */
const NEWLINE = 0x0a;

/** A `MARK` position on the stack, distinguishable from any pickled value. */
const MARK = Symbol('pickle.mark');

const TEXT_DECODER = new TextDecoder('utf-8', {fatal: true});
const TEXT_ENCODER = new TextEncoder();

/**
 * The one-pass reader.
 *
 * The byte cursor, the value stack and the memo are one resource the opcode
 * handlers all read and write, so this is a class rather than a set of
 * functions passing a handle between them.
 */
class PickleReader {
  private offset = 0;
  private readonly stack: unknown[] = [];
  private readonly memo = new Map<number, unknown>();
  /** The factory that built each instance, for a later `BUILD`. */
  private readonly factories = new WeakMap<object, PickleObjectFactory>();

  constructor(
    private readonly data: Uint8Array,
    private readonly resolve: PickleGlobalResolver,
  ) {}

  load(): unknown {
    for (;;) {
      const opcode = this.readByte();
      if (opcode === OPCODE.STOP) {
        return this.pop();
      }
      this.step(opcode);
    }
  }

  private step(opcode: number): void {
    switch (opcode) {
      case OPCODE.PROTO:
        this.readProto();
        return;
      case OPCODE.FRAME:
        this.readLength(8);
        return;
      case OPCODE.MARK:
        this.stack.push(MARK);
        return;
      case OPCODE.POP:
        this.pop();
        return;
      case OPCODE.POP_MARK:
        this.popMark();
        return;
      case OPCODE.MEMOIZE:
        this.memo.set(this.memo.size, this.peek());
        return;
      case OPCODE.BINPUT:
        this.memo.set(this.readByte(), this.peek());
        return;
      case OPCODE.LONG_BINPUT:
        this.memo.set(this.readLength(4), this.peek());
        return;
      case OPCODE.BINGET:
        this.stack.push(this.readMemo(this.readByte()));
        return;
      case OPCODE.LONG_BINGET:
        this.stack.push(this.readMemo(this.readLength(4)));
        return;
      case OPCODE.NONE:
        this.stack.push(null);
        return;
      case OPCODE.NEWTRUE:
        this.stack.push(true);
        return;
      case OPCODE.NEWFALSE:
        this.stack.push(false);
        return;
      case OPCODE.BININT:
        this.stack.push(this.readInt32());
        return;
      case OPCODE.BININT1:
        this.stack.push(this.readByte());
        return;
      case OPCODE.BININT2:
        this.stack.push(this.readLength(2));
        return;
      case OPCODE.LONG1:
        this.stack.push(this.readLong(this.readByte()));
        return;
      case OPCODE.LONG4:
        this.stack.push(this.readLong(this.readInt32()));
        return;
      case OPCODE.BINFLOAT:
        this.stack.push(this.readFloat64());
        return;
      case OPCODE.SHORT_BINUNICODE:
        this.stack.push(this.readText(this.readByte()));
        return;
      case OPCODE.BINUNICODE:
        this.stack.push(this.readText(this.readLength(4)));
        return;
      case OPCODE.BINUNICODE8:
        this.stack.push(this.readText(this.readLength(8)));
        return;
      case OPCODE.SHORT_BINBYTES:
        this.stack.push(this.readBytes(this.readByte()));
        return;
      case OPCODE.BINBYTES:
        this.stack.push(this.readBytes(this.readLength(4)));
        return;
      case OPCODE.BINBYTES8:
        this.stack.push(this.readBytes(this.readLength(8)));
        return;
      case OPCODE.EMPTY_LIST:
      case OPCODE.EMPTY_TUPLE:
        this.stack.push([]);
        return;
      case OPCODE.EMPTY_DICT:
        this.stack.push(new Map<unknown, unknown>());
        return;
      case OPCODE.EMPTY_SET:
        this.stack.push(new Set<unknown>());
        return;
      case OPCODE.TUPLE:
        this.stack.push(this.popMark());
        return;
      case OPCODE.TUPLE1:
        this.stack.push(this.popMany(1));
        return;
      case OPCODE.TUPLE2:
        this.stack.push(this.popMany(2));
        return;
      case OPCODE.TUPLE3:
        this.stack.push(this.popMany(3));
        return;
      case OPCODE.FROZENSET:
        this.stack.push(new Set(this.popMark()));
        return;
      case OPCODE.APPEND:
        this.appendAll(this.popMany(1));
        return;
      case OPCODE.APPENDS:
        this.appendAll(this.popMark());
        return;
      case OPCODE.ADDITEMS:
        this.addAll(this.popMark());
        return;
      case OPCODE.SETITEM:
        this.setAll(this.popMany(2));
        return;
      case OPCODE.SETITEMS:
        this.setAll(this.popMark());
        return;
      case OPCODE.STACK_GLOBAL:
        this.pushGlobal(this.popMany(2));
        return;
      case OPCODE.GLOBAL:
        this.pushGlobal([this.readLine(), this.readLine()]);
        return;
      case OPCODE.REDUCE:
        this.reduce();
        return;
      case OPCODE.NEWOBJ:
        this.newObj(false);
        return;
      case OPCODE.NEWOBJ_EX:
        this.newObj(true);
        return;
      case OPCODE.BUILD:
        this.build();
        return;
      default:
        throw new PickleError(
          PickleErrorCode.UNSUPPORTED_OPCODE,
          `Unsupported pickle opcode ${describeOpcode(opcode)}.`,
        );
    }
  }

  private readProto(): void {
    const protocol = this.readByte();
    if (protocol > MAX_READER_PROTOCOL) {
      throw new PickleError(
        PickleErrorCode.UNSUPPORTED_OPCODE,
        `Unsupported pickle protocol ${protocol}; the highest supported is ` +
          `${MAX_READER_PROTOCOL}.`,
      );
    }
  }

  private pushGlobal(parts: readonly unknown[]): void {
    const [module, name] = parts;
    if (typeof module !== 'string' || typeof name !== 'string') {
      throw new PickleError(
        PickleErrorCode.UNSUPPORTED_TARGET,
        'A pickle global must name a module and a name as strings.',
      );
    }
    this.stack.push(this.resolve({module, name}));
  }

  private reduce(): void {
    const [factory, args] = this.popMany(2);
    this.pushInstance(factory, toArguments(args), new Map());
  }

  private newObj(withKeywords: boolean): void {
    const [factory, args, kwargs] = withKeywords
      ? this.popMany(3)
      : [...this.popMany(2), null];
    this.pushInstance(factory, toArguments(args), toKeywords(kwargs));
  }

  private pushInstance(
    factory: unknown,
    args: readonly unknown[],
    kwargs: ReadonlyMap<unknown, unknown>,
  ): void {
    if (!isObjectFactory(factory)) {
      throw new PickleError(
        PickleErrorCode.UNSUPPORTED_TARGET,
        'A pickle payload may only build an instance of a global its ' +
          'resolver allowed.',
      );
    }
    const instance = factory.create(args, kwargs);
    if (isMutableObject(instance)) {
      this.factories.set(instance, factory);
    }
    this.stack.push(instance);
  }

  private build(): void {
    const [state] = this.popMany(1);
    const instance = this.peek();
    const factory = isMutableObject(instance)
      ? this.factories.get(instance)
      : undefined;
    if (factory?.setState) {
      const built = factory.setState(instance, state);
      if (built !== instance) {
        this.repointMemo(instance, built);
      }
      this.stack[this.stack.length - 1] = built;
      return;
    }
    // Python's default `BUILD` updates the instance's attribute dictionary,
    // which is what a `Map` instance stands for here.
    if (instance instanceof Map && state instanceof Map) {
      for (const [key, value] of state) {
        instance.set(key, value);
      }
      return;
    }
    throw new PickleError(
      PickleErrorCode.UNSUPPORTED_TARGET,
      'A pickle BUILD needs a factory that applies state, or a dictionary ' +
        'instance and a dictionary state.',
    );
  }

  /**
   * Points every memo slot holding `instance` at the value a `BUILD` made.
   *
   * CPython writes `MEMOIZE` before `BUILD` and mutates the instance in place,
   * so the slot names the finished object. A factory that returns a different
   * value would otherwise leave the slot on the placeholder, and every later
   * `BINGET` of it would read a half-built object.
   */
  private repointMemo(instance: unknown, built: unknown): void {
    for (const [slot, value] of this.memo) {
      if (value === instance) {
        this.memo.set(slot, built);
      }
    }
  }

  private appendAll(values: readonly unknown[]): void {
    const target = this.peek();
    if (!Array.isArray(target)) {
      throw new PickleError(
        PickleErrorCode.UNSUPPORTED_TARGET,
        'A pickle APPEND needs a list.',
      );
    }
    target.push(...values);
  }

  private addAll(values: readonly unknown[]): void {
    const target = this.peek();
    if (!(target instanceof Set)) {
      throw new PickleError(
        PickleErrorCode.UNSUPPORTED_TARGET,
        'A pickle ADDITEMS needs a set.',
      );
    }
    for (const value of values) {
      target.add(value);
    }
  }

  private setAll(entries: readonly unknown[]): void {
    const target = this.peek();
    if (!(target instanceof Map)) {
      throw new PickleError(
        PickleErrorCode.UNSUPPORTED_TARGET,
        'A pickle SETITEM needs a dictionary.',
      );
    }
    if (entries.length % 2 !== 0) {
      throw new PickleError(
        PickleErrorCode.UNSUPPORTED_TARGET,
        'A pickle SETITEMS needs one value per key.',
      );
    }
    for (let index = 0; index < entries.length; index += 2) {
      target.set(entries[index], entries[index + 1]);
    }
  }

  private readMemo(key: number): unknown {
    if (!this.memo.has(key)) {
      throw new PickleError(
        PickleErrorCode.UNKNOWN_MEMO,
        `Pickle payload reads memo slot ${key}, which it never wrote.`,
      );
    }
    return this.memo.get(key);
  }

  private peek(): unknown {
    if (this.stack.length === 0) {
      throw new PickleError(
        PickleErrorCode.STACK_UNDERFLOW,
        'Pickle payload reads an empty stack.',
      );
    }
    return this.stack[this.stack.length - 1];
  }

  private pop(): unknown {
    return this.popMany(1)[0];
  }

  private popMany(count: number): unknown[] {
    if (this.stack.length < count) {
      throw new PickleError(
        PickleErrorCode.STACK_UNDERFLOW,
        `Pickle payload needs ${count} stack entries but has ` +
          `${this.stack.length}.`,
      );
    }
    return this.stack.splice(this.stack.length - count, count);
  }

  private popMark(): unknown[] {
    const mark = this.stack.lastIndexOf(MARK);
    if (mark < 0) {
      throw new PickleError(
        PickleErrorCode.STACK_UNDERFLOW,
        'Pickle payload closes a group it never opened.',
      );
    }
    return this.stack.splice(mark).slice(1);
  }

  private take(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.data.length) {
      throw new PickleError(
        PickleErrorCode.TRUNCATED_PAYLOAD,
        `Pickle payload of ${this.data.length} bytes ends before the ` +
          `${length} bytes an opcode at offset ${this.offset} needs.`,
      );
    }
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  private view(length: number): DataView {
    const slice = this.take(length);
    return new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
  }

  private readByte(): number {
    return this.take(1)[0];
  }

  /** Reads the little-endian unsigned length operand of `width` bytes. */
  private readLength(width: 2 | 4 | 8): number {
    const view = this.view(width);
    if (width === 2) {
      return view.getUint16(0, true);
    }
    if (width === 4) {
      return view.getUint32(0, true);
    }
    const value = view.getBigUint64(0, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PickleError(
        PickleErrorCode.TRUNCATED_PAYLOAD,
        `Pickle payload declares a length of ${value} bytes, which exceeds ` +
          'the largest length this reader can address.',
      );
    }
    return Number(value);
  }

  private readInt32(): number {
    return this.view(4).getInt32(0, true);
  }

  private readFloat64(): number {
    return this.view(8).getFloat64(0, false);
  }

  private readText(length: number): string {
    return TEXT_DECODER.decode(this.take(length));
  }

  private readBytes(length: number): Uint8Array {
    return Uint8Array.from(this.take(length));
  }

  /** Reads a newline-terminated operand, which only `GLOBAL` uses here. */
  private readLine(): string {
    const newline = this.data.indexOf(NEWLINE, this.offset);
    if (newline < 0) {
      throw new PickleError(
        PickleErrorCode.TRUNCATED_PAYLOAD,
        'Pickle payload ends before the end of a text operand.',
      );
    }
    const line = this.readText(newline - this.offset);
    this.offset += 1;
    return line;
  }

  /** Reads the little-endian two's-complement integer of `length` bytes. */
  private readLong(length: number): number | bigint {
    const bytes = this.take(length);
    if (bytes.length === 0) {
      return 0;
    }
    let value = 0n;
    for (let index = bytes.length - 1; index >= 0; index--) {
      value = (value << 8n) | BigInt(bytes[index]);
    }
    if (bytes[bytes.length - 1] & 0x80) {
      value -= 1n << BigInt(bytes.length * 8);
    }
    return withinSafeRange(value) ? Number(value) : value;
  }
}

function withinSafeRange(value: bigint): boolean {
  return (
    value <= BigInt(Number.MAX_SAFE_INTEGER) &&
    value >= BigInt(Number.MIN_SAFE_INTEGER)
  );
}

function describeOpcode(opcode: number): string {
  const name = OPCODE_NAMES.get(opcode);
  const hex = `0x${opcode.toString(16).padStart(2, '0')}`;
  return name ? `${name} (${hex})` : hex;
}

function isMutableObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isObjectFactory(value: unknown): value is PickleObjectFactory {
  return (
    isMutableObject(value) &&
    typeof (value as {create?: unknown}).create === 'function'
  );
}

function toArguments(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new PickleError(
      PickleErrorCode.UNSUPPORTED_TARGET,
      'A pickle payload must pass its constructor arguments as a tuple.',
    );
  }
  return value;
}

function toKeywords(value: unknown): ReadonlyMap<unknown, unknown> {
  if (value === null) {
    return new Map();
  }
  if (!(value instanceof Map)) {
    throw new PickleError(
      PickleErrorCode.UNSUPPORTED_TARGET,
      'A pickle NEWOBJ_EX must pass its keyword arguments as a dictionary.',
    );
  }
  return value;
}

/**
 * Reads a pickle payload without executing any of it.
 *
 * Python values map onto JavaScript as follows: `None` to `null`, `bool` to
 * `boolean`, `int` and `float` to `number` (an `int` too large for a `number`
 * becomes a `bigint`), `str` to `string`, `bytes` to `Uint8Array`, `list` and
 * `tuple` to `Array`, `dict` to `Map`, `set` and `frozenset` to `Set`.
 * Anything else is whatever the resolver's factory builds.
 *
 * @param data The payload, which is untrusted input.
 * @param resolve Resolves each global the payload names, or refuses it by
 *   throwing {@link PickleSecurityError}.
 * @returns The decoded value.
 * @throws PickleError when the payload is malformed or uses an unsupported
 *   opcode, and {@link PickleSecurityError} when the resolver refuses a
 *   global.
 */
export function loadPickle(
  data: Uint8Array,
  resolve: PickleGlobalResolver,
): unknown {
  return new PickleReader(data, resolve).load();
}

/** The one-pass writer, which owns the growing output buffer. */
class PickleWriter {
  private readonly bytes: number[] = [];
  /** The values currently being written, so a cycle is a reported error. */
  private readonly open = new Set<unknown>();

  dump(value: unknown): Uint8Array {
    this.bytes.push(OPCODE.PROTO, WRITER_PROTOCOL);
    this.write(value);
    this.bytes.push(OPCODE.STOP);
    return Uint8Array.from(this.bytes);
  }

  private write(value: unknown): void {
    if (value === null) {
      this.bytes.push(OPCODE.NONE);
      return;
    }
    switch (typeof value) {
      case 'boolean':
        this.bytes.push(value ? OPCODE.NEWTRUE : OPCODE.NEWFALSE);
        return;
      case 'number':
        this.writeNumber(value);
        return;
      case 'bigint':
        this.writeBigInt(value);
        return;
      case 'string':
        this.writeText(value);
        return;
      case 'object':
        this.writeObject(value as object);
        return;
      default:
        throw new PickleError(
          PickleErrorCode.UNSUPPORTED_VALUE,
          `A pickle payload cannot hold a ${typeof value} value.`,
        );
    }
  }

  private writeObject(value: object): void {
    if (this.open.has(value)) {
      throw new PickleError(
        PickleErrorCode.UNSUPPORTED_VALUE,
        'A pickle payload cannot hold a value that contains itself.',
      );
    }
    this.open.add(value);
    try {
      this.writeContainer(value);
    } finally {
      this.open.delete(value);
    }
  }

  private writeContainer(value: object): void {
    if (value instanceof Uint8Array) {
      this.writeBytes(value);
    } else if (Array.isArray(value)) {
      this.writeList(value);
    } else if (value instanceof Map) {
      this.writeDict(value);
    } else if (value instanceof Set) {
      this.writeSet(value);
    } else if (isPickleInstance(value)) {
      this.writeInstance(value);
    } else {
      this.writeDict(new Map(Object.entries(value)));
    }
  }

  private writeNumber(value: number): void {
    if (!Number.isInteger(value)) {
      this.bytes.push(OPCODE.BINFLOAT);
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, value, false);
      this.pushBytes(new Uint8Array(view.buffer));
      return;
    }
    if (value >= 0 && value < BYTE_LIMIT) {
      this.bytes.push(OPCODE.BININT1, value);
      return;
    }
    if (value >= 0 && value < UINT16_LIMIT) {
      this.bytes.push(OPCODE.BININT2, value & 0xff, value >> 8);
      return;
    }
    if (value >= INT32_MIN && value <= INT32_MAX) {
      this.bytes.push(OPCODE.BININT);
      this.pushInt32(value);
      return;
    }
    this.writeBigInt(BigInt(value));
  }

  private writeBigInt(value: bigint): void {
    const magnitude = twosComplement(value);
    if (magnitude.length < BYTE_LIMIT) {
      this.bytes.push(OPCODE.LONG1, magnitude.length);
    } else {
      this.bytes.push(OPCODE.LONG4);
      this.pushInt32(magnitude.length);
    }
    this.pushBytes(magnitude);
  }

  private writeText(value: string): void {
    const encoded = TEXT_ENCODER.encode(value);
    if (encoded.length < BYTE_LIMIT) {
      this.bytes.push(OPCODE.SHORT_BINUNICODE, encoded.length);
    } else {
      this.bytes.push(OPCODE.BINUNICODE);
      this.pushInt32(encoded.length);
    }
    this.pushBytes(encoded);
  }

  private writeBytes(value: Uint8Array): void {
    if (value.length < BYTE_LIMIT) {
      this.bytes.push(OPCODE.SHORT_BINBYTES, value.length);
    } else {
      this.bytes.push(OPCODE.BINBYTES);
      this.pushInt32(value.length);
    }
    this.pushBytes(value);
  }

  private writeList(value: readonly unknown[]): void {
    this.bytes.push(OPCODE.EMPTY_LIST);
    if (value.length === 0) {
      return;
    }
    this.bytes.push(OPCODE.MARK);
    for (const element of value) {
      this.write(element);
    }
    this.bytes.push(OPCODE.APPENDS);
  }

  private writeTuple(value: readonly unknown[]): void {
    if (value.length === 0) {
      this.bytes.push(OPCODE.EMPTY_TUPLE);
      return;
    }
    this.bytes.push(OPCODE.MARK);
    for (const element of value) {
      this.write(element);
    }
    this.bytes.push(OPCODE.TUPLE);
  }

  private writeDict(value: ReadonlyMap<unknown, unknown>): void {
    this.bytes.push(OPCODE.EMPTY_DICT);
    if (value.size === 0) {
      return;
    }
    this.bytes.push(OPCODE.MARK);
    for (const [key, element] of value) {
      this.write(key);
      this.write(element);
    }
    this.bytes.push(OPCODE.SETITEMS);
  }

  private writeSet(value: ReadonlySet<unknown>): void {
    this.bytes.push(OPCODE.EMPTY_SET);
    if (value.size === 0) {
      return;
    }
    this.bytes.push(OPCODE.MARK);
    for (const element of value) {
      this.write(element);
    }
    this.bytes.push(OPCODE.ADDITEMS);
  }

  private writeInstance(value: PickleInstance): void {
    this.writeText(value.global.module);
    this.writeText(value.global.name);
    this.bytes.push(OPCODE.STACK_GLOBAL);
    this.writeTuple(value.args);
    this.bytes.push(OPCODE.NEWOBJ);
    this.write(value.state);
    this.bytes.push(OPCODE.BUILD);
  }

  private pushBytes(value: Uint8Array): void {
    for (const byte of value) {
      this.bytes.push(byte);
    }
  }

  private pushInt32(value: number): void {
    const view = new DataView(new ArrayBuffer(4));
    view.setInt32(0, value, true);
    this.pushBytes(new Uint8Array(view.buffer));
  }
}

/** Returns the little-endian two's-complement bytes pickle stores a long as. */
function twosComplement(value: bigint): Uint8Array {
  if (value === 0n) {
    return new Uint8Array(0);
  }
  const negative = value < 0n;
  const terminator = negative ? -1n : 0n;
  const bytes: number[] = [];
  let remaining = value;
  while (remaining !== terminator) {
    bytes.push(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
  const signBitSet = bytes.length > 0 && (bytes[bytes.length - 1] & 0x80) !== 0;
  if (signBitSet !== negative) {
    bytes.push(negative ? 0xff : 0x00);
  }
  return Uint8Array.from(bytes);
}

/**
 * Writes a pickle payload at protocol 4.
 *
 * JavaScript values map onto Python as the inverse of {@link loadPickle}: a
 * plain object is written as a `dict`, and a {@link PickleInstance} as an
 * instance of the class it names. The payload carries no memo, so a value that
 * contains itself is reported rather than written.
 *
 * @param value The value to write.
 * @returns The payload.
 * @throws PickleError when the value cannot be written.
 */
export function dumpPickle(value: unknown): Uint8Array {
  return new PickleWriter().dump(value);
}
