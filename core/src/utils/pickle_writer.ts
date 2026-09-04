/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A writer for the Python pickle wire format, limited to Pydantic models.
 *
 * {@link dumpPydanticModel} emits the protocol 4 payload CPython produces for
 * a `BaseModel`: name the class, allocate it with `NEWOBJ`, then `BUILD` it
 * from the four-key state dict Pydantic's `__setstate__` reads. The fields go
 * in as plain data, so the payload names one class and nothing else.
 *
 * JavaScript values map to their Python counterparts:
 *
 * | JavaScript | Python |
 * | --- | --- |
 * | `null` | `None` |
 * | `boolean` | `bool` |
 * | integral `number` | `int` |
 * | any other `number` | `float` |
 * | `string` | `str` |
 * | a typed array | `bytes` |
 * | `Array` | `list` |
 * | a plain object | `dict` |
 *
 * A value of any other kind raises: silently writing it as something else
 * would put a wrong value in the database rather than fail the write.
 *
 * Memoisation is left out. The memo only serves the `GET` opcodes, and this
 * writer emits none, so every value is written where it is used.
 */

import {isPlainObject, Opcode} from './pickle_reader.js';

/** The pickle protocol version this writer emits. */
const PICKLE_PROTOCOL = 4;

/** Pydantic keeps a model's fields under this key of its pickled state. */
const PYDANTIC_FIELDS_KEY = '__dict__';

/** The keys Pydantic's `__setstate__` reads besides {@link PYDANTIC_FIELDS_KEY}. */
const PYDANTIC_EXTRA_KEY = '__pydantic_extra__';
const PYDANTIC_FIELDS_SET_KEY = '__pydantic_fields_set__';
const PYDANTIC_PRIVATE_KEY = '__pydantic_private__';

/** Largest length a one-byte length prefix can carry. */
const SHORT_LENGTH_LIMIT = 0x100;

/** Bounds of the integer opcodes, from the widest down to the narrowest. */
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;
const UINT16_MAX = 0xffff;
const UINT8_MAX = 0xff;

/** Bytes a growable payload starts with, doubling from there. */
const INITIAL_CAPACITY = 256;

const UTF8_ENCODER = new TextEncoder();

/**
 * Names a value in an error message without printing its contents.
 *
 * Only a value {@link PickleWriter.value} cannot write reaches this, so `null`
 * and the container kinds are already handled by the time it is called.
 */
function describe(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return typeof value;
  }
  return `an instance of ${value.constructor?.name ?? 'an anonymous class'}`;
}

/**
 * Encodes an integer as the little-endian two's-complement bytes `LONG1`
 * carries, in the narrowest width that keeps its sign.
 *
 * The caller writes anything that fits four bytes as a `BININT`, so the value
 * here always needs at least five and the loop always runs.
 */
function twosComplementBytes(value: bigint): Uint8Array {
  const digits: number[] = [];
  let remaining = value;
  while (remaining !== 0n && remaining !== -1n) {
    digits.push(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
  const topBitSet = (digits[digits.length - 1] & 0x80) > 0;
  if (value >= 0n && topBitSet) {
    digits.push(0x00);
  } else if (value < 0n && !topBitSet) {
    digits.push(0xff);
  }
  return Uint8Array.from(digits);
}

/**
 * A pickle payload under construction.
 *
 * The buffer, its length and the position every write lands at are one piece
 * of state with a lifecycle, so they live together rather than being threaded
 * between free functions.
 */
class PickleWriter {
  private buffer = new Uint8Array(INITIAL_CAPACITY);
  private view = new DataView(this.buffer.buffer);
  private length = 0;

  /** Writes a class's pickled form and returns the finished payload. */
  pydanticModel(
    moduleName: string,
    className: string,
    fields: Readonly<Record<string, unknown>>,
  ): Uint8Array {
    const present = Object.entries(fields).filter(
      ([, value]) => value !== undefined,
    );

    this.opcode(Opcode.PROTO);
    this.byte(PICKLE_PROTOCOL);

    this.str(moduleName);
    this.str(className);
    this.opcode(Opcode.STACK_GLOBAL);
    this.opcode(Opcode.EMPTY_TUPLE);
    this.opcode(Opcode.NEWOBJ);

    this.opcode(Opcode.EMPTY_DICT);
    this.opcode(Opcode.MARK);
    this.str(PYDANTIC_FIELDS_KEY);
    this.dict(present);
    this.str(PYDANTIC_EXTRA_KEY);
    this.opcode(Opcode.NONE);
    this.str(PYDANTIC_FIELDS_SET_KEY);
    this.stringSet(present.map(([key]) => key));
    this.str(PYDANTIC_PRIVATE_KEY);
    this.opcode(Opcode.NONE);
    this.opcode(Opcode.SETITEMS);

    this.opcode(Opcode.BUILD);
    this.opcode(Opcode.STOP);

    return this.buffer.slice(0, this.length);
  }

  private value(value: unknown): void {
    if (value === null) {
      this.opcode(Opcode.NONE);
      return;
    }
    switch (typeof value) {
      case 'boolean':
        this.opcode(value ? Opcode.NEWTRUE : Opcode.NEWFALSE);
        return;
      case 'string':
        this.str(value);
        return;
      case 'number':
        this.number(value);
        return;
      default:
        break;
    }
    if (ArrayBuffer.isView(value)) {
      this.bytes(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      );
      return;
    }
    if (Array.isArray(value)) {
      this.list(value);
      return;
    }
    if (isPlainObject(value)) {
      this.dict(Object.entries(value).filter(([, item]) => item !== undefined));
      return;
    }
    throw new Error(`Cannot write ${describe(value)} as a pickled value.`);
  }

  private number(value: number): void {
    if (!Number.isInteger(value)) {
      this.opcode(Opcode.BINFLOAT);
      this.float64(value);
      return;
    }
    if (value >= 0 && value <= UINT8_MAX) {
      this.opcode(Opcode.BININT1);
      this.byte(value);
      return;
    }
    if (value >= 0 && value <= UINT16_MAX) {
      this.opcode(Opcode.BININT2);
      this.uint16(value);
      return;
    }
    if (value >= INT32_MIN && value <= INT32_MAX) {
      this.opcode(Opcode.BININT);
      this.int32(value);
      return;
    }
    const digits = twosComplementBytes(BigInt(value));
    this.opcode(Opcode.LONG1);
    this.byte(digits.length);
    this.raw(digits);
  }

  private str(value: string): void {
    const encoded = UTF8_ENCODER.encode(value);
    if (encoded.length < SHORT_LENGTH_LIMIT) {
      this.opcode(Opcode.SHORT_BINUNICODE);
      this.byte(encoded.length);
    } else {
      this.opcode(Opcode.BINUNICODE);
      this.uint32(encoded.length);
    }
    this.raw(encoded);
  }

  private bytes(value: Uint8Array): void {
    if (value.length < SHORT_LENGTH_LIMIT) {
      this.opcode(Opcode.SHORT_BINBYTES);
      this.byte(value.length);
    } else {
      this.opcode(Opcode.BINBYTES);
      this.uint32(value.length);
    }
    this.raw(value);
  }

  private list(items: readonly unknown[]): void {
    this.opcode(Opcode.EMPTY_LIST);
    if (items.length === 0) {
      return;
    }
    this.opcode(Opcode.MARK);
    for (const item of items) {
      this.value(item);
    }
    this.opcode(Opcode.APPENDS);
  }

  private dict(entries: ReadonlyArray<readonly [string, unknown]>): void {
    this.opcode(Opcode.EMPTY_DICT);
    if (entries.length === 0) {
      return;
    }
    this.opcode(Opcode.MARK);
    for (const [key, item] of entries) {
      this.str(key);
      this.value(item);
    }
    this.opcode(Opcode.SETITEMS);
  }

  private stringSet(members: readonly string[]): void {
    this.opcode(Opcode.EMPTY_SET);
    if (members.length === 0) {
      return;
    }
    this.opcode(Opcode.MARK);
    for (const member of members) {
      this.str(member);
    }
    this.opcode(Opcode.ADDITEMS);
  }

  private opcode(opcode: Opcode): void {
    this.byte(opcode);
  }

  private byte(value: number): void {
    this.reserve(1);
    this.buffer[this.length] = value;
    this.length += 1;
  }

  private uint16(value: number): void {
    this.reserve(2);
    this.view.setUint16(this.length, value, true);
    this.length += 2;
  }

  private uint32(value: number): void {
    this.reserve(4);
    this.view.setUint32(this.length, value, true);
    this.length += 4;
  }

  private int32(value: number): void {
    this.reserve(4);
    this.view.setInt32(this.length, value, true);
    this.length += 4;
  }

  private float64(value: number): void {
    this.reserve(8);
    this.view.setFloat64(this.length, value, false);
    this.length += 8;
  }

  private raw(chunk: Uint8Array): void {
    this.reserve(chunk.length);
    this.buffer.set(chunk, this.length);
    this.length += chunk.length;
  }

  private reserve(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.buffer.length) {
      return;
    }
    let capacity = this.buffer.length;
    while (capacity < needed) {
      capacity *= 2;
    }
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
    this.view = new DataView(grown.buffer);
  }
}

/**
 * Writes the pickle payload CPython produces for a Pydantic model.
 *
 * A field whose value is `undefined` is left out of the state dict entirely,
 * and out of `__pydantic_fields_set__` with it. Pydantic then restores that
 * field from its declared default, which is what a model pickled by a version
 * that did not have the field yet also does.
 *
 * @param moduleName The class's Python module, e.g.
 *   `google.adk.events.event_actions`.
 * @param className The class's name within that module.
 * @param fields The model's fields, under their Python names.
 * @return The pickled bytes, readable by CPython's `pickle.loads`.
 * @throws If a field holds a value with no Python counterpart.
 */
export function dumpPydanticModel(
  moduleName: string,
  className: string,
  fields: Readonly<Record<string, unknown>>,
): Uint8Array {
  return new PickleWriter().pydanticModel(moduleName, className, fields);
}
