/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A read-only reader for the Python pickle wire format.
 *
 * Pickle is a stack machine whose payload names Python callables and asks the
 * interpreter to apply them, which is why `pickle.loads` on untrusted bytes
 * runs arbitrary code. This reader resolves no name of its own and calls
 * nothing of its own: every `GLOBAL`/`STACK_GLOBAL` goes to the caller's
 * {@link GlobalResolver}, and `REDUCE`/`NEWOBJ`/`NEWOBJ_EX` invoke only the
 * {@link PickleGlobal.construct} that resolver returned. A caller that
 * resolves names to inert data builders cannot be made to run the payload.
 *
 * Python values arrive as their closest JavaScript counterpart:
 *
 * | Python | JavaScript |
 * | --- | --- |
 * | `None` | `null` |
 * | `bool` | `boolean` |
 * | `int` | `number`, or `bigint` when it exceeds the safe integer range |
 * | `float` | `number` |
 * | `str` | `string` |
 * | `bytes`, `bytearray` | `Uint8Array` |
 * | `list`, `tuple` | `unknown[]` |
 * | `dict` | `Map<unknown, unknown>` |
 * | `set`, `frozenset` | `Set<unknown>` |
 * | an instance | whatever the resolver's `construct` returned |
 *
 * A `dict` becomes a `Map` rather than an object because Python dict keys are
 * not restricted to strings: a plain object would lose a tuple key and would
 * collide the key `1` with the key `'1'`.
 *
 * Protocols 2 through 5 are read. Nothing below 2 is: CPython's
 * `pickle.DEFAULT_PROTOCOL` is 4 and its `HIGHEST_PROTOCOL` is 5, so no
 * writer on a supported Python emits protocol 0 or 1. An opcode outside
 * {@link Opcode} raises rather than being skipped, because skipping one
 * leaves the stack misaligned and yields a plausible-looking wrong value.
 */

/**
 * Largest payload this reader accepts, in bytes.
 *
 * The bytes come from a database column and are untrusted, so a length prefix
 * inside a corrupt payload must not be able to allocate without limit. The
 * cap is far above any real `EventActions` blob, which holds session state
 * deltas rather than media.
 */
export const MAX_PICKLE_BYTES = 32 * 1024 * 1024;

/**
 * Largest number of values the machine stack may hold.
 *
 * The memo needs no separate cap: it is a `Map`, and every entry costs at
 * least one opcode byte, so {@link MAX_PICKLE_BYTES} already bounds it.
 */
export const MAX_PICKLE_STACK = 100000;

/** What a resolved global can do when the payload applies it. */
export interface PickleGlobal {
  /**
   * Builds a value from the arguments the payload supplies.
   *
   * Called for `REDUCE`, `NEWOBJ` and `NEWOBJ_EX`. A resolver is expected to
   * return inert data; this reader neither inspects nor invokes the result.
   */
  construct(args: unknown[]): unknown;
}

/**
 * Resolves the `module.name` reference a pickle payload names.
 *
 * Throw from the resolver to refuse a name. The reader lets the throw
 * propagate out of {@link loadPickle}.
 */
export type GlobalResolver = (module: string, name: string) => PickleGlobal;

/** The pickle opcodes this reader understands. */
export enum Opcode {
  MARK = 0x28, // '('
  EMPTY_TUPLE = 0x29, // ')'
  STOP = 0x2e, // '.'
  BINBYTES = 0x42, // 'B'
  SHORT_BINBYTES = 0x43, // 'C'
  BINFLOAT = 0x47, // 'G'
  BININT = 0x4a, // 'J'
  BININT1 = 0x4b, // 'K'
  BININT2 = 0x4d, // 'M'
  NONE = 0x4e, // 'N'
  REDUCE = 0x52, // 'R'
  BINUNICODE = 0x58, // 'X'
  EMPTY_LIST = 0x5d, // ']'
  APPEND = 0x61, // 'a'
  BUILD = 0x62, // 'b'
  GLOBAL = 0x63, // 'c'
  APPENDS = 0x65, // 'e'
  BINGET = 0x68, // 'h'
  LONG_BINGET = 0x6a, // 'j'
  BINPUT = 0x71, // 'q'
  LONG_BINPUT = 0x72, // 'r'
  SETITEM = 0x73, // 's'
  TUPLE = 0x74, // 't'
  SETITEMS = 0x75, // 'u'
  EMPTY_DICT = 0x7d, // '}'
  PROTO = 0x80,
  NEWOBJ = 0x81,
  TUPLE1 = 0x85,
  TUPLE2 = 0x86,
  TUPLE3 = 0x87,
  NEWTRUE = 0x88,
  NEWFALSE = 0x89,
  LONG1 = 0x8a,
  LONG4 = 0x8b,
  SHORT_BINUNICODE = 0x8c,
  BINUNICODE8 = 0x8d,
  BINBYTES8 = 0x8e,
  EMPTY_SET = 0x8f,
  ADDITEMS = 0x90,
  FROZENSET = 0x91,
  NEWOBJ_EX = 0x92,
  STACK_GLOBAL = 0x93,
  MEMOIZE = 0x94,
  FRAME = 0x95,
  BYTEARRAY8 = 0x96,
}

const UTF8_DECODER = new TextDecoder('utf-8', {fatal: true});

/**
 * Decodes the bytes of a newline-terminated line, which `GLOBAL` uses for a
 * module and a name. Latin-1 maps every byte to a character without failing.
 */
function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }
  return out;
}

/**
 * Narrows to an object whose properties a `BUILD` state may be copied onto,
 * and which the writer may encode as a Python dict.
 *
 * A null-prototype map counts. `trimTempDeltaState` builds `stateDelta` that
 * way so a `__proto__` key cannot re-parent it, and those actions reach the
 * pickle writer on the legacy v0 write path.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Returns a `bigint` as a `number` when that loses nothing, else unchanged. */
function narrowInteger(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

/** Reads a little-endian two's-complement integer, as `LONG1`/`LONG4` store it. */
function decodeSignedLittleEndian(bytes: Uint8Array): number | bigint {
  if (bytes.length === 0) {
    return 0;
  }
  let magnitude = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    magnitude = (magnitude << 8n) | BigInt(bytes[i]);
  }
  const isNegative = (bytes[bytes.length - 1] & 0x80) !== 0;
  return narrowInteger(
    isNegative ? magnitude - (1n << BigInt(bytes.length * 8)) : magnitude,
  );
}

/** Copies one `BUILD` state mapping onto the object it belongs to. */
function applyStateMapping(target: unknown, state: unknown): void {
  if (state === null) {
    return;
  }
  if (!(state instanceof Map)) {
    throw new Error(`Pickle BUILD expected a dict state, got ${typeof state}.`);
  }
  if (!isPlainObject(target)) {
    throw new Error('Pickle BUILD applied to a value that is not an object.');
  }
  for (const [key, value] of state) {
    if (typeof key === 'string') {
      target[key] = value;
    }
  }
}

/**
 * Applies a `BUILD` state to its object, mirroring Python's default
 * `__dict__` update. The state is a dict, or a `(state, slotstate)` pair.
 */
function applyPickleState(target: unknown, state: unknown): void {
  if (Array.isArray(state) && state.length === 2) {
    applyStateMapping(target, state[0]);
    applyStateMapping(target, state[1]);
    return;
  }
  applyStateMapping(target, state);
}

/** The stack machine that interprets one payload. */
class PickleMachine {
  private position = 0;
  private readonly stack: unknown[] = [];
  private readonly markPositions: number[] = [];
  private readonly memo = new Map<number, unknown>();
  private readonly view: DataView;

  constructor(
    private readonly data: Uint8Array,
    private readonly resolve: GlobalResolver,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  /** Runs the payload to its `STOP` opcode and returns the value it left. */
  run(): unknown {
    for (;;) {
      const opcode = this.readByte();
      if (opcode === Opcode.STOP) {
        return this.pop();
      }
      this.step(opcode);
      if (this.stack.length > MAX_PICKLE_STACK) {
        throw new Error(
          `Pickle stack exceeded ${MAX_PICKLE_STACK} entries; the payload is corrupt.`,
        );
      }
    }
  }

  private step(opcode: number): void {
    switch (opcode) {
      case Opcode.PROTO:
        this.readByte();
        return;
      case Opcode.FRAME:
        // A frame is only a length hint for buffered readers, but its prefix
        // still has to be consumed.
        this.readUint64();
        return;
      case Opcode.MARK:
        this.markPositions.push(this.stack.length);
        return;

      case Opcode.BINPUT:
        this.memo.set(this.readByte(), this.peek());
        return;
      case Opcode.LONG_BINPUT:
        this.memo.set(this.readUint32(), this.peek());
        return;
      case Opcode.MEMOIZE:
        this.memo.set(this.memo.size, this.peek());
        return;
      case Opcode.BINGET:
        this.stack.push(this.readMemo(this.readByte()));
        return;
      case Opcode.LONG_BINGET:
        this.stack.push(this.readMemo(this.readUint32()));
        return;

      case Opcode.NONE:
        this.stack.push(null);
        return;
      case Opcode.NEWTRUE:
        this.stack.push(true);
        return;
      case Opcode.NEWFALSE:
        this.stack.push(false);
        return;
      case Opcode.BININT:
        this.stack.push(this.readInt32());
        return;
      case Opcode.BININT1:
        this.stack.push(this.readByte());
        return;
      case Opcode.BININT2:
        this.stack.push(this.readUint16());
        return;
      case Opcode.LONG1:
        this.stack.push(
          decodeSignedLittleEndian(this.readBytes(this.readByte())),
        );
        return;
      case Opcode.LONG4:
        this.stack.push(
          decodeSignedLittleEndian(this.readBytes(this.readUint32())),
        );
        return;
      case Opcode.BINFLOAT:
        this.stack.push(this.readFloat64());
        return;

      case Opcode.BINUNICODE:
        this.stack.push(this.readUtf8(this.readUint32()));
        return;
      case Opcode.SHORT_BINUNICODE:
        this.stack.push(this.readUtf8(this.readByte()));
        return;
      case Opcode.BINUNICODE8:
        this.stack.push(this.readUtf8(this.readUint64()));
        return;
      case Opcode.SHORT_BINBYTES:
        this.stack.push(this.readBytes(this.readByte()));
        return;
      case Opcode.BINBYTES:
        this.stack.push(this.readBytes(this.readUint32()));
        return;
      case Opcode.BINBYTES8:
      case Opcode.BYTEARRAY8:
        this.stack.push(this.readBytes(this.readUint64()));
        return;

      case Opcode.EMPTY_DICT:
        this.stack.push(new Map<unknown, unknown>());
        return;
      case Opcode.EMPTY_LIST:
        this.stack.push([]);
        return;
      case Opcode.EMPTY_TUPLE:
        this.stack.push([]);
        return;
      case Opcode.TUPLE:
        this.stack.push(this.popMark());
        return;
      case Opcode.TUPLE1:
      case Opcode.TUPLE2:
      case Opcode.TUPLE3:
        this.stack.push(this.popCount(opcode - Opcode.TUPLE1 + 1));
        return;
      case Opcode.EMPTY_SET:
        this.stack.push(new Set<unknown>());
        return;
      case Opcode.FROZENSET:
        this.stack.push(new Set(this.popMark()));
        return;

      case Opcode.SETITEM: {
        const value = this.pop();
        const key = this.pop();
        this.asDict().set(key, value);
        return;
      }
      case Opcode.SETITEMS: {
        const pairs = this.popMark();
        const target = this.asDict();
        for (let i = 0; i + 1 < pairs.length; i += 2) {
          target.set(pairs[i], pairs[i + 1]);
        }
        return;
      }
      case Opcode.APPEND: {
        const item = this.pop();
        this.asList().push(item);
        return;
      }
      case Opcode.APPENDS: {
        const items = this.popMark();
        this.asList().push(...items);
        return;
      }
      case Opcode.ADDITEMS: {
        const items = this.popMark();
        const target = this.peek();
        if (!(target instanceof Set)) {
          throw new Error(
            'Pickle ADDITEMS applied to a value that is not a set.',
          );
        }
        for (const item of items) {
          target.add(item);
        }
        return;
      }
      case Opcode.BUILD: {
        const state = this.pop();
        applyPickleState(this.peek(), state);
        return;
      }
      case Opcode.GLOBAL: {
        const module = this.readLine();
        const name = this.readLine();
        this.stack.push(this.resolve(module, name));
        return;
      }
      case Opcode.STACK_GLOBAL: {
        const name = this.pop();
        const module = this.pop();
        if (typeof module !== 'string' || typeof name !== 'string') {
          throw new Error('Pickle STACK_GLOBAL expected two strings.');
        }
        this.stack.push(this.resolve(module, name));
        return;
      }
      case Opcode.REDUCE:
      case Opcode.NEWOBJ:
        this.applyGlobal();
        return;
      case Opcode.NEWOBJ_EX:
        // The keyword arguments are dropped: a resolver builds inert data from
        // the positional arguments, exactly as it does for NEWOBJ.
        this.pop();
        this.applyGlobal();
        return;

      default:
        throw new Error(
          `Unsupported pickle opcode 0x${opcode.toString(16).padStart(2, '0')} at byte ${this.position - 1}.`,
        );
    }
  }

  private pop(): unknown {
    if (this.stack.length === 0) {
      throw new Error('Pickle payload is truncated: the stack is empty.');
    }
    return this.stack.pop();
  }

  private peek(): unknown {
    if (this.stack.length === 0) {
      throw new Error('Pickle payload is truncated: the stack is empty.');
    }
    return this.stack[this.stack.length - 1];
  }

  private popCount(count: number): unknown[] {
    if (this.stack.length < count) {
      throw new Error('Pickle payload is truncated: the stack is too short.');
    }
    return this.stack.splice(this.stack.length - count, count);
  }

  private popMark(): unknown[] {
    const start = this.markPositions.pop();
    if (start === undefined) {
      throw new Error('Pickle payload closed a group that was never opened.');
    }
    return this.stack.splice(start);
  }

  private readMemo(index: number): unknown {
    if (!this.memo.has(index)) {
      throw new Error(`Pickle payload referenced unset memo entry ${index}.`);
    }
    return this.memo.get(index);
  }

  /** Pops an argument tuple and the global under it, and applies the two. */
  private applyGlobal(): void {
    const args = this.pop();
    if (!Array.isArray(args)) {
      throw new Error('Pickle payload applied a global to a non-tuple.');
    }
    const target = this.pop();
    if (
      typeof target !== 'object' ||
      target === null ||
      typeof (target as PickleGlobal).construct !== 'function'
    ) {
      throw new Error('Pickle payload applied a value that is not a global.');
    }
    this.stack.push((target as PickleGlobal).construct(args));
  }

  private asDict(): Map<unknown, unknown> {
    const target = this.peek();
    if (!(target instanceof Map)) {
      throw new Error('Pickle SETITEM applied to a value that is not a dict.');
    }
    return target;
  }

  private asList(): unknown[] {
    const target = this.peek();
    if (!Array.isArray(target)) {
      throw new Error('Pickle APPEND applied to a value that is not a list.');
    }
    return target;
  }

  private readByte(): number {
    if (this.position >= this.data.length) {
      throw new Error('Pickle payload is truncated: expected another opcode.');
    }
    return this.data[this.position++];
  }

  private readBytes(length: number): Uint8Array {
    const end = this.position + length;
    if (length < 0 || end > this.data.length) {
      throw new Error(
        `Pickle payload is truncated: wanted ${length} bytes at ${this.position}.`,
      );
    }
    const slice = this.data.subarray(this.position, end);
    this.position = end;
    return slice;
  }

  private readUtf8(length: number): string {
    return UTF8_DECODER.decode(this.readBytes(length));
  }

  private readInt32(): number {
    const value = this.view.getInt32(this.requireRoom(4), true);
    this.position += 4;
    return value;
  }

  private readUint16(): number {
    const value = this.view.getUint16(this.requireRoom(2), true);
    this.position += 2;
    return value;
  }

  private readUint32(): number {
    const value = this.view.getUint32(this.requireRoom(4), true);
    this.position += 4;
    return value;
  }

  private readUint64(): number {
    const value = this.view.getBigUint64(this.requireRoom(8), true);
    this.position += 8;
    if (value > BigInt(MAX_PICKLE_BYTES)) {
      throw new Error(
        `Pickle payload declares a ${value}-byte length, over the ${MAX_PICKLE_BYTES}-byte limit.`,
      );
    }
    return Number(value);
  }

  private readFloat64(): number {
    const value = this.view.getFloat64(this.requireRoom(8), false);
    this.position += 8;
    return value;
  }

  private requireRoom(length: number): number {
    if (this.position + length > this.data.length) {
      throw new Error(
        `Pickle payload is truncated: wanted ${length} bytes at ${this.position}.`,
      );
    }
    return this.position;
  }

  private readLine(): string {
    const end = this.data.indexOf(0x0a, this.position);
    if (end === -1) {
      throw new Error('Pickle payload is truncated: unterminated line.');
    }
    const line = decodeLatin1(this.data.subarray(this.position, end));
    this.position = end + 1;
    return line;
  }
}

/**
 * Reads one pickle payload.
 *
 * @param data The pickled bytes.
 * @param resolve Resolves each `module.name` the payload names. Throw from it
 *   to refuse a name; the throw propagates out of this call.
 * @return The value the payload's `STOP` opcode leaves on the stack.
 * @throws If the payload is truncated, malformed, larger than
 *   {@link MAX_PICKLE_BYTES}, or uses an opcode this reader does not support.
 */
export function loadPickle(data: Uint8Array, resolve: GlobalResolver): unknown {
  if (data.length > MAX_PICKLE_BYTES) {
    throw new Error(
      `Pickle payload is ${data.length} bytes, over the ${MAX_PICKLE_BYTES}-byte limit.`,
    );
  }
  return new PickleMachine(data, resolve).run();
}
