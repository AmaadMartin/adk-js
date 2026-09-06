/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  isPythonObject,
  loadsRestricted,
  pickleToJson,
  UnpicklingError,
  type PickleValue,
  type PythonObject,
} from '../../../src/sessions/migration/restricted_pickle.js';
import {
  BUILD_FROM_NON_DICT_STATE,
  BUILTIN_REDUCE_DICT,
  BUILTIN_REDUCE_LIST,
  BUILTIN_REDUCE_OBJECT,
  BUILTIN_REDUCE_SET,
  BUILTIN_REDUCE_SET_NO_ARGS,
  BUILTIN_REDUCE_STR,
  BUILTIN_REDUCE_STR_NO_ARGS,
  CONTAINERS,
  COPYREG_RECONSTRUCTOR,
  DATETIME_STATE_DELTA,
  ENUM_MEMBER,
  fixtureBytes,
  FLOAT_AND_BOOL,
  HUGE_INT,
  INT_WIDTHS,
  NAIVE_DATETIME_STATE_DELTA,
  NESTED_ACTIONS,
  NEWOBJ_EX_OBJECT,
  NON_STRING_DICT_KEYS,
  PROTOCOL_2_ACTIONS,
  RECONSTRUCTOR_WITHOUT_CLASS,
  REFUSED_CALLABLE,
  REFUSED_MODULE,
  SIMPLE_STATE_DELTA,
  STDLIB_VALUES,
  TEXT_AND_BYTES,
  TIMEDELTA_AND_TIMEZONE,
  TIMEDELTA_NON_NUMERIC,
  TIMEZONE_NON_NUMERIC,
} from './testdata/pickled_actions.js';

/** Loads a committed fixture. */
function load(payload: string, allowUnknownGlobals = false): PickleValue {
  return loadsRestricted(fixtureBytes(payload), {allowUnknownGlobals});
}

/** Narrows a decoded value to a {@link PythonObject}, failing the test if not. */
function asPythonObject(value: PickleValue | undefined): PythonObject {
  if (value === undefined || !isPythonObject(value)) {
    expect.fail(`Expected a PythonObject, got ${String(value)}`);
  }
  return value;
}

/** Narrows a decoded value to the `Map` a Python dict decodes to. */
function asMap(value: PickleValue | undefined): Map<PickleValue, PickleValue> {
  if (!(value instanceof Map)) {
    expect.fail(`Expected a Map, got ${String(value)}`);
  }
  return value;
}

/** Narrows a decoded value to the array a Python list or tuple decodes to. */
function asList(value: PickleValue | undefined): PickleValue[] {
  if (!Array.isArray(value)) {
    expect.fail(`Expected an array, got ${String(value)}`);
  }
  return value;
}

/** Returns the `state_delta` of a decoded `EventActions` payload. */
function stateDeltaOf(payload: string): Map<PickleValue, PickleValue> {
  const actions = asPythonObject(load(payload));
  return asMap(actions.attributes['state_delta']);
}

/** Builds a payload byte by byte, for opcodes `pickle.dumps` never emits. */
function pickleBytes(...parts: Array<number | number[] | string>): Uint8Array {
  const bytes: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') {
      bytes.push(part);
    } else if (typeof part === 'string') {
      bytes.push(...new TextEncoder().encode(part));
    } else {
      bytes.push(...part);
    }
  }
  return new Uint8Array(bytes);
}

/** A `SHORT_BINUNICODE` opcode carrying `text`. */
function shortUnicode(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  return [0x8c, bytes.length, ...bytes];
}

/** Little-endian byte encoding of `value` over `width` bytes. */
function littleEndian(value: number, width: number): number[] {
  return Array.from(
    {length: width},
    (_, index) => (value >>> (index * 8)) & 0xff,
  );
}

const PROTO_5 = [0x80, 0x05];
const STOP = 0x2e;

describe('loadsRestricted', () => {
  it('reconstructs an EventActions payload as an inert record', () => {
    const actions = asPythonObject(load(SIMPLE_STATE_DELTA));

    expect(actions.pyClass).toBe(
      'google.adk.events.event_actions.EventActions',
    );
    expect(asMap(actions.attributes['state_delta']).get('skey')).toBe(4);
    expect(actions.attributes['artifact_delta']).toBeInstanceOf(Map);
  });

  it('drops the pydantic bookkeeping keys that sit beside __dict__', () => {
    const actions = asPythonObject(load(SIMPLE_STATE_DELTA));

    expect(Object.keys(actions.attributes)).not.toContain(
      '__pydantic_fields_set__',
    );
    expect(Object.keys(actions.attributes)).not.toContain('__pydantic_extra__');
    expect(Object.keys(actions.attributes)).not.toContain(
      '__pydantic_private__',
    );
  });

  it('reads a protocol 2 payload, which uses GLOBAL, BINPUT and BINUNICODE', () => {
    const actions = asPythonObject(load(PROTOCOL_2_ACTIONS));

    expect(actions.pyClass).toBe(
      'google.adk.events.event_actions.EventActions',
    );
    expect(asMap(actions.attributes['state_delta']).get('skey')).toBe(4);
  });

  it('reads integers of every width, signed and arbitrary precision', () => {
    // -1 is written as a signed BININT, and the two huge values as LONG1.
    expect(load(INT_WIDTHS)).toEqual([
      0,
      255,
      256,
      65535,
      65536,
      2147483647,
      -1,
      2n ** 70n,
      -(2n ** 70n),
    ]);
  });

  it('reads floats, booleans and none', () => {
    expect(load(FLOAT_AND_BOOL)).toEqual([1.5, -0.25, true, false, null]);
  });

  it('reads short and long unicode and bytes strings', () => {
    const values = asList(load(TEXT_AND_BYTES));

    expect(values[0]).toBe('ascii');
    expect(values[1]).toBe('unicode \u00e9\u2713');
    expect(values[2]).toEqual(new Uint8Array([0x00, 0x01, 0xff]));
    expect(values[3]).toBe('x'.repeat(300));
    expect(values[4]).toEqual(new Uint8Array(300).fill(0x79));
  });

  it('reads empty and populated lists, tuples, dicts and sets', () => {
    const values = asList(load(CONTAINERS));

    expect(values.slice(0, 2)).toEqual([[], []]);
    expect(values[2]).toEqual(new Map());
    expect(values[3]).toEqual(new Set());
    expect(values[4]).toEqual(new Set());
    expect(values[5]).toEqual([1, 2, 3]);
    expect(values[6]).toEqual([1, 2, 3, 4]);
    expect(asMap(values[7]).get('a')).toBe(1);
    expect(values[8]).toEqual(new Set([1, 2]));
  });

  it('keeps non-string dict keys distinct, which a plain object would collapse', () => {
    const decoded = asMap(load(NON_STRING_DICT_KEYS));

    expect(decoded.get(1)).toBe('one');
    expect([...decoded.keys()]).toEqual([1, [2, 3]]);
  });

  it('reuses a memoized value rather than decoding it twice', () => {
    // `NESTED_ACTIONS` reaches its `__pydantic_fields_set__` entries through
    // BINGET after MEMOIZE, so a broken memo throws before this assertion.
    const actions = asPythonObject(load(NESTED_ACTIONS));
    const confirmations = asMap(
      actions.attributes['requested_tool_confirmations'],
    );

    expect(
      asPythonObject(confirmations.get('fc-confirm')).attributes['hint'],
    ).toBe('Authorize execution?');
  });

  it('reconstructs a nested model tree', () => {
    const actions = asPythonObject(load(NESTED_ACTIONS));
    const compaction = asPythonObject(actions.attributes['compaction']);
    const content = asPythonObject(compaction.attributes['compacted_content']);
    const parts = asList(content.attributes['parts']);

    expect(compaction.pyClass).toBe(
      'google.adk.events.event_actions.EventCompaction',
    );
    expect(asPythonObject(parts[0]).attributes['text']).toBe('summary');
  });

  it('reads an aware datetime by applying its offset', () => {
    expect(stateDeltaOf(DATETIME_STATE_DELTA).get('last_seen')).toEqual(
      new Date(Date.UTC(2026, 0, 1, 12, 30, 0, 0)),
    );
  });

  it('reads a naive datetime as local time', () => {
    expect(stateDeltaOf(NAIVE_DATETIME_STATE_DELTA).get('last_seen')).toEqual(
      new Date(2026, 0, 1, 12, 30, 0, 0),
    );
  });

  it('reads the stdlib data types state_delta can hold', () => {
    const [
      decimalValue,
      pathValue,
      uuidValue,
      dateValue,
      timeValue,
      orderedDict,
      defaultDict,
    ] = asList(load(STDLIB_VALUES));

    expect(decimalValue).toBe('1.5');
    expect(pathValue).toBe('a/b');
    expect(asPythonObject(uuidValue).pyClass).toBe('uuid.UUID');
    expect(dateValue).toEqual(new Date(2026, 0, 2));
    expect(timeValue).toBe('12:30:01.500');
    expect(asMap(orderedDict).get('a')).toBe(1);
    expect(asMap(defaultDict).get('a')).toEqual([1]);
  });

  it.each([
    ['builtins.str', BUILTIN_REDUCE_STR, 'hello'],
    ['builtins.dict', BUILTIN_REDUCE_DICT, new Map()],
    ['builtins.list', BUILTIN_REDUCE_LIST, []],
    ['builtins.set', BUILTIN_REDUCE_SET, new Set([1, 2])],
  ])(
    'reconstructs a %s payload built through REDUCE',
    (_name, payload, expected) => {
      expect(load(payload)).toEqual(expected);
    },
  );

  it('reconstructs builtins.object as an empty record', () => {
    expect(asPythonObject(load(BUILTIN_REDUCE_OBJECT)).pyClass).toBe(
      'builtins.object',
    );
  });

  it('reads the real class out of a copyreg._reconstructor payload', () => {
    expect(asPythonObject(load(COPYREG_RECONSTRUCTOR)).pyClass).toBe(
      'google.adk.events.ui_widget.UiWidget',
    );
  });

  it('reads a string-valued enum member as its bare value', () => {
    expect(load(ENUM_MEMBER)).toBe('MEDIA_RESOLUTION_LOW');
  });

  it('reads a NEWOBJ_EX payload, discarding its keyword arguments', () => {
    expect(asPythonObject(load(NEWOBJ_EX_OBJECT)).pyClass).toBe(
      'google.adk.events.event_actions.NewObjEx',
    );
  });

  it('refuses a payload naming a callable outside the allowlist', () => {
    expect(() => load(REFUSED_CALLABLE)).toThrow(UnpicklingError);
    expect(() => load(REFUSED_CALLABLE)).toThrow(/builtins\.eval/);
  });

  it('refuses a payload naming a module outside the allowlist', () => {
    expect(() => load(REFUSED_MODULE)).toThrow(
      /Refusing to load posix\.system/,
    );
  });

  it('points a refused payload at the opt-in that would read it', () => {
    expect(() => load(REFUSED_CALLABLE)).toThrow(/allowUnsafeUnpickling/);
  });

  it('resolves an unknown global to an inert record when opted in', () => {
    const decoded = asPythonObject(load(REFUSED_CALLABLE, true));

    expect(decoded.pyClass).toBe('builtins.eval');
    expect(decoded.attributes).toEqual({});
    expect(process.env['ADK_MIGRATION_PICKLE_RCE']).toBeUndefined();
  });

  it('reads a LONG4 integer, which only a very wide value needs', () => {
    expect(load(HUGE_INT)).toBe(2n ** 2100n);
  });

  it('reads a timedelta as milliseconds and a timezone as minutes', () => {
    expect(load(TIMEDELTA_AND_TIMEZONE)).toEqual([86_402_003, 330]);
  });

  it.each([
    ['timedelta', TIMEDELTA_NON_NUMERIC, 0],
    ['timezone', TIMEZONE_NON_NUMERIC, 0],
  ])(
    'reads a %s built from a non-numeric argument as zero',
    (_name, payload, expected) => {
      expect(load(payload)).toBe(expected);
    },
  );

  it('falls back to the plumbing class when _reconstructor has no class argument', () => {
    expect(asPythonObject(load(RECONSTRUCTOR_WITHOUT_CLASS)).pyClass).toBe(
      'copyreg._reconstructor',
    );
  });

  it.each([
    ['builtins.set', BUILTIN_REDUCE_SET_NO_ARGS, new Set()],
    ['builtins.str', BUILTIN_REDUCE_STR_NO_ARGS, null],
  ])(
    'reconstructs %s from an empty argument list',
    (_name, payload, expected) => {
      expect(load(payload)).toEqual(expected);
    },
  );

  it('ignores a BUILD state that is not a dict', () => {
    expect(asPythonObject(load(BUILD_FROM_NON_DICT_STATE)).attributes).toEqual(
      {},
    );
  });

  it('treats a REDUCE callable that is not a class handle as opaque', () => {
    const payload = pickleBytes(
      PROTO_5,
      shortUnicode('google.adk.events.ui_widget'),
      shortUnicode('UiWidget'),
      0x93, // STACK_GLOBAL
      0x29, // EMPTY_TUPLE
      0x81, // NEWOBJ -> an object, not a class handle
      0x29, // EMPTY_TUPLE
      0x52, // REDUCE
      STOP,
    );

    expect(asPythonObject(loadsRestricted(payload)).pyClass).toBe(
      'google.adk.events.ui_widget.UiWidget',
    );
  });

  it('throws when an opcode needs more stack values than were pushed', () => {
    expect(() => loadsRestricted(pickleBytes(PROTO_5, 0x86, STOP))).toThrow(
      'A pickle opcode needed 2 stack values but found 0.',
    );
  });

  it('throws rather than hanging on a truncated payload', () => {
    const truncated = fixtureBytes(SIMPLE_STATE_DELTA).slice(0, 40);

    expect(() => loadsRestricted(truncated)).toThrow(
      /ended unexpectedly|empty stack/,
    );
  });

  it('throws on an unsupported opcode instead of skipping it', () => {
    // 0x00 is not an opcode in any protocol.
    expect(() => loadsRestricted(pickleBytes(PROTO_5, 0x00, STOP))).toThrow(
      /Unsupported pickle opcode 0x0/,
    );
  });

  it('throws on a protocol newer than this reader', () => {
    expect(() => loadsRestricted(pickleBytes(0x80, 0x06, STOP))).toThrow(
      'Unsupported pickle protocol 6.',
    );
  });

  it('throws when a length prefix runs past the end of the payload', () => {
    const overlongString = pickleBytes(PROTO_5, 0x8c, 0x20, 'short', STOP);

    expect(() => loadsRestricted(overlongString)).toThrow(
      'The pickle payload ended unexpectedly.',
    );
  });

  it('reads a GLOBAL opcode whose module name has no terminating newline', () => {
    const unterminated = pickleBytes(PROTO_5, 0x63, 'builtins');

    expect(() => loadsRestricted(unterminated)).toThrow(
      'The pickle payload ended unexpectedly.',
    );
  });

  it('reads BINUNICODE8 and BINBYTES8, which only huge values would emit', () => {
    const payload = pickleBytes(
      PROTO_5,
      0x8d,
      littleEndian(2, 4),
      [0, 0, 0, 0],
      'hi',
      0x8e,
      littleEndian(1, 4),
      [0, 0, 0, 0],
      [0x7f],
      0x86,
      STOP,
    );

    expect(loadsRestricted(payload)).toEqual(['hi', new Uint8Array([0x7f])]);
  });

  it('reads the mark-terminated DICT, LIST and TUPLE opcodes', () => {
    const payload = pickleBytes(
      PROTO_5,
      0x28, // MARK, for the enclosing TUPLE
      0x28, // MARK
      0x4b,
      0x01, // BININT1 1
      0x6c, // LIST -> [1]
      0x28, // MARK
      shortUnicode('k'),
      0x4b,
      0x02, // BININT1 2
      0x64, // DICT -> {'k': 2}
      0x74, // TUPLE
      STOP,
    );

    expect(loadsRestricted(payload)).toEqual([[1], new Map([['k', 2]])]);
  });

  it('reads BININT and LONG_BINGET, which a large payload would emit', () => {
    const payload = pickleBytes(
      PROTO_5,
      0x4a,
      littleEndian(-2, 4),
      0x72,
      littleEndian(300, 4),
      0x6a,
      littleEndian(300, 4),
      0x86,
      STOP,
    );

    expect(loadsRestricted(payload)).toEqual([-2, -2]);
  });

  it('throws when a memo slot is read before it is written', () => {
    expect(() =>
      loadsRestricted(pickleBytes(PROTO_5, 0x68, 0x07, STOP)),
    ).toThrow('Memo slot 7 was read before it was written.');
  });

  it('throws when an opcode needs a mark that was never pushed', () => {
    expect(() => loadsRestricted(pickleBytes(PROTO_5, 0x74, STOP))).toThrow(
      'Found an opcode with no matching MARK.',
    );
  });

  it('throws when SETITEM finds something other than a dict', () => {
    const payload = pickleBytes(
      PROTO_5,
      0x5d,
      0x4b,
      0x01,
      0x4b,
      0x02,
      0x73,
      STOP,
    );

    expect(() => loadsRestricted(payload)).toThrow(
      'SETITEM expects a dict on the stack.',
    );
  });

  it('throws when APPEND finds something other than a list', () => {
    const payload = pickleBytes(PROTO_5, 0x7d, 0x4b, 0x01, 0x61, STOP);

    expect(() => loadsRestricted(payload)).toThrow(
      'APPEND expects a list on the stack.',
    );
  });

  it('throws when ADDITEMS finds something other than a set', () => {
    const payload = pickleBytes(PROTO_5, 0x5d, 0x28, 0x4b, 0x01, 0x90, STOP);

    expect(() => loadsRestricted(payload)).toThrow(
      'ADDITEMS expects a set on the stack.',
    );
  });

  it('throws when STACK_GLOBAL is not given two strings', () => {
    const payload = pickleBytes(PROTO_5, 0x4b, 0x01, 0x4b, 0x02, 0x93, STOP);

    expect(() => loadsRestricted(payload)).toThrow(
      'STACK_GLOBAL expects two strings.',
    );
  });

  it('throws when REDUCE is not given a class and an argument list', () => {
    const payload = pickleBytes(PROTO_5, 0x4b, 0x01, 0x29, 0x52, STOP);

    expect(() => loadsRestricted(payload)).toThrow(
      'REDUCE expects a class and an argument list.',
    );
  });

  it('throws when BUILD is not given an object', () => {
    const payload = pickleBytes(PROTO_5, 0x4b, 0x01, 0x7d, 0x62, STOP);

    expect(() => loadsRestricted(payload)).toThrow(
      'BUILD expects an object to apply state to.',
    );
  });

  it('throws when a datetime state is not a byte string', () => {
    const payload = pickleBytes(
      PROTO_5,
      shortUnicode('datetime'),
      shortUnicode('datetime'),
      0x93,
      0x4b,
      0x01,
      0x85,
      0x52,
      STOP,
    );

    expect(() => loadsRestricted(payload)).toThrow(
      'Expected a packed byte state for a datetime value.',
    );
  });

  it('throws when an opcode reads an empty stack', () => {
    expect(() => loadsRestricted(pickleBytes(PROTO_5, 0x94, STOP))).toThrow(
      'A pickle opcode read an empty stack.',
    );
  });

  it('throws when a value length exceeds what the reader can address', () => {
    const payload = pickleBytes(
      PROTO_5,
      0x8d,
      [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f],
      STOP,
    );

    expect(() => loadsRestricted(payload)).toThrow(
      'The pickle payload declares a length this reader cannot address.',
    );
  });
});

describe('pickleToJson', () => {
  it('renders every decoded shape as JSON', () => {
    const value: PickleValue = new Map<PickleValue, PickleValue>([
      ['text', 'hello'],
      ['flag', true],
      ['count', 3],
      ['big', 2n ** 40n],
      ['nothing', null],
      ['bytes', new Uint8Array([1, 2, 3])],
      ['when', new Date(Date.UTC(2026, 0, 1))],
      ['list', [1, 2]],
      ['set', new Set([1, 2])],
    ]);

    expect(pickleToJson(value)).toEqual({
      text: 'hello',
      flag: true,
      count: 3,
      big: 2 ** 40,
      nothing: null,
      bytes: 'AQID',
      when: '2026-01-01T00:00:00.000Z',
      list: [1, 2],
      set: [1, 2],
    });
  });

  it('stringifies a non-string dict key, which JSON cannot hold', () => {
    expect(pickleToJson(load(NON_STRING_DICT_KEYS))).toEqual({
      '1': 'one',
      '2,3': 'tuple',
    });
  });

  it('renders a reconstructed object as its attributes', () => {
    expect(pickleToJson(load(ENUM_MEMBER))).toBe('MEDIA_RESOLUTION_LOW');
    expect(pickleToJson(load(SIMPLE_STATE_DELTA))).toMatchObject({
      state_delta: {skey: 4},
    });
  });
});
