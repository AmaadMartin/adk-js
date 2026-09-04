/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  dumpPickle,
  isPickleInstance,
  loadPickle,
  PickleError,
  PickleErrorCode,
  PickleGlobal,
  PickleInstance,
  PickleObjectFactory,
  PickleSecurityError,
} from '../../src/utils/pickle_utils.js';
import {
  payloadBytes,
  PLAIN_DATA_PAYLOAD,
  PROTOCOL_2_WIDGET_PAYLOAD,
  PROTOCOL_5_DATA_PAYLOAD,
  REDUCE_VALUES_PAYLOAD,
  SHARED_REFERENCE_PAYLOAD,
  SINGLE_APPEND_PAYLOAD,
  TUPLES_PAYLOAD,
  WIDGET_PAYLOAD,
} from './pickle_payload_fixtures.js';

const OPCODE = {
  MARK: 0x28,
  EMPTY_TUPLE: 0x29,
  STOP: 0x2e,
  POP: 0x30,
  POP_MARK: 0x31,
  DUP: 0x32,
  BININT1: 0x4b,
  NONE: 0x4e,
  PERSID: 0x50,
  BINPERSID: 0x51,
  REDUCE: 0x52,
  STRING: 0x53,
  EMPTY_LIST: 0x5d,
  BUILD: 0x62,
  GLOBAL: 0x63,
  BINGET: 0x68,
  INST: 0x69,
  LONG_BINGET: 0x6a,
  OBJ: 0x6f,
  LONG_BINPUT: 0x72,
  SETITEM: 0x73,
  EMPTY_DICT: 0x7d,
  PROTO: 0x80,
  NEWOBJ: 0x81,
  EXT1: 0x82,
  TUPLE1: 0x85,
  BINUNICODE8: 0x8d,
  BINBYTES8: 0x8e,
  EMPTY_SET: 0x8f,
  ADDITEMS: 0x90,
  NEWOBJ_EX: 0x92,
  STACK_GLOBAL: 0x93,
  MEMOIZE: 0x94,
} as const;

/** Writes `SHORT_BINUNICODE` for a string short enough to use it. */
function shortUnicode(value: string): number[] {
  const encoded = Array.from(Buffer.from(value, 'utf-8'));
  return [0x8c, encoded.length, ...encoded];
}

function payload(...parts: Array<number | number[]>): Uint8Array {
  return Uint8Array.from(parts.flat());
}

/**
 * Handcrafts a payload that calls `module.name(argument)` when it loads.
 *
 * Mirrors `_call_global_payload` in adk-python's
 * `tests/unittests/sessions/test_dynamic_pickle_type.py`.
 */
function callGlobalPayload(
  module: string,
  name: string,
  argument: string,
): Uint8Array {
  return payload(
    [OPCODE.PROTO, 4],
    shortUnicode(module),
    shortUnicode(name),
    OPCODE.STACK_GLOBAL,
    shortUnicode(argument),
    OPCODE.TUPLE1,
    OPCODE.REDUCE,
    OPCODE.STOP,
  );
}

/** Builds an instance as a `Map`, the way a pydantic model decodes. */
const MAP_FACTORY: PickleObjectFactory = {create: () => new Map()};

/** Builds an empty list, the way `builtins.list` decodes. */
const LIST_FACTORY: PickleObjectFactory = {create: () => []};

const TEST_ALLOWLIST = new Map<string, PickleObjectFactory>([
  ['example.models.Widget', MAP_FACTORY],
  ['collections.OrderedDict', MAP_FACTORY],
  ['collections.defaultdict', MAP_FACTORY],
  ['builtins.list', LIST_FACTORY],
  ['builtins.set', {create: (args) => new Set(asArray(args[0]))}],
  ['__builtin__.set', {create: (args) => new Set(asArray(args[0]))}],
]);

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function resolveTestGlobal(pickleGlobal: PickleGlobal): PickleObjectFactory {
  const factory = TEST_ALLOWLIST.get(
    `${pickleGlobal.module}.${pickleGlobal.name}`,
  );
  if (!factory) {
    throw new PickleSecurityError(
      `Refusing to load ${pickleGlobal.module}.${pickleGlobal.name}.`,
    );
  }
  return factory;
}

function load(base64Payload: string): unknown {
  return loadPickle(payloadBytes(base64Payload), resolveTestGlobal);
}

function asMap(value: unknown): Map<unknown, unknown> {
  if (!(value instanceof Map)) {
    expect.fail(`Expected a Map, got ${String(value)}.`);
  }
  return value;
}

describe('loadPickle', () => {
  it('decodes every primitive and container CPython writes', () => {
    const decoded = asMap(load(PLAIN_DATA_PAYLOAD));

    expect(decoded.get('text')).toBe('hello');
    expect(decoded.get('unicode')).toBe('café ✓');
    expect(decoded.get('byte_int')).toBe(200);
    expect(decoded.get('short_int')).toBe(4242);
    expect(decoded.get('int32')).toBe(123456789);
    expect(decoded.get('negative')).toBe(-7);
    expect(decoded.get('big_int')).toBe(2n ** 80n);
    expect(decoded.get('negative_big_int')).toBe(-(2n ** 80n));
    expect(decoded.get('float')).toBe(1.5);
    expect(decoded.get('true')).toBe(true);
    expect(decoded.get('false')).toBe(false);
    expect(decoded.get('none')).toBeNull();
    expect(decoded.get('bytes')).toEqual(Uint8Array.from([0x00, 0x01, 0xfe]));
    expect(decoded.get('list')).toEqual([1, 2, 3]);
    expect(decoded.get('tuple')).toEqual([1, 'two', 3]);
    expect(decoded.get('set')).toEqual(new Set([1, 2]));
    expect(decoded.get('frozenset')).toEqual(new Set(['a']));
    expect(decoded.get('empty_list')).toEqual([]);
    expect(decoded.get('empty_tuple')).toEqual([]);
    expect(decoded.get('empty_dict')).toEqual(new Map());
    expect(decoded.get('long_text')).toBe('x'.repeat(260));
    expect(decoded.get('long_bytes')).toEqual(
      Uint8Array.from(Buffer.alloc(260, 'y')),
    );
  });

  it('decodes a nested container', () => {
    const decoded = asMap(load(PLAIN_DATA_PAYLOAD));

    expect(decoded.get('nested')).toEqual(
      new Map([['inner', [new Map([['k', 'v']])]]]),
    );
  });

  it('resolves a memoized reference to the same object', () => {
    const decoded = load(SHARED_REFERENCE_PAYLOAD);

    expect(Array.isArray(decoded)).toBe(true);
    const [first, second] = decoded as unknown[];
    expect(first).toBe(second);
    expect(first).toEqual(new Map([['shared', true]]));
  });

  it('decodes one, two and three element tuples', () => {
    const decoded = asMap(load(TUPLES_PAYLOAD));

    expect(decoded.get('one')).toEqual([1]);
    expect(decoded.get('two')).toEqual([1, 2]);
    expect(decoded.get('three')).toEqual([1, 2, 3]);
  });

  it('decodes a single-element list, which CPython writes with APPEND', () => {
    expect(load(SINGLE_APPEND_PAYLOAD)).toEqual([42]);
  });

  it('builds a REDUCE value through the resolver', () => {
    const decoded = asMap(load(REDUCE_VALUES_PAYLOAD));

    expect(decoded.get('ordered')).toEqual(
      new Map([
        ['b', 1],
        ['a', 2],
      ]),
    );
    expect(decoded.get('default')).toEqual(new Map([['k', [1]]]));
  });

  it('builds a NEWOBJ instance and applies its BUILD state', () => {
    const decoded = asMap(load(WIDGET_PAYLOAD));

    expect(decoded.get('__dict__')).toEqual(
      new Map<unknown, unknown>([
        ['label', 'left'],
        ['size', 3],
      ]),
    );
    expect(decoded.get('__pydantic_extra__')).toBeNull();
    expect(decoded.get('__pydantic_fields_set__')).toEqual(
      new Set(['label', 'size']),
    );
  });

  it('reads a protocol 2 payload, which names its globals with GLOBAL', () => {
    const decoded = asMap(load(PROTOCOL_2_WIDGET_PAYLOAD));

    expect(decoded.get('__dict__')).toEqual(
      new Map<unknown, unknown>([
        ['label', 'left'],
        ['size', 3],
      ]),
    );
  });

  it('reads a protocol 5 payload, skipping its FRAME opcode', () => {
    expect(load(PROTOCOL_5_DATA_PAYLOAD)).toEqual(
      new Map<unknown, unknown>([
        ['proto', 5],
        ['list', [1, 2]],
      ]),
    );
  });

  it('reads a memo slot written with LONG_BINPUT', () => {
    const decoded = loadPickle(
      payload(
        [OPCODE.PROTO, 4],
        shortUnicode('once'),
        [OPCODE.LONG_BINPUT, 0x2c, 0x01, 0x00, 0x00],
        OPCODE.POP,
        [OPCODE.LONG_BINGET, 0x2c, 0x01, 0x00, 0x00],
        OPCODE.STOP,
      ),
      resolveTestGlobal,
    );

    expect(decoded).toBe('once');
  });

  it('reads the 64-bit length prefixes', () => {
    const eightByteLength = [0x02, 0, 0, 0, 0, 0, 0, 0];
    const decoded = loadPickle(
      payload(
        [OPCODE.PROTO, 4],
        OPCODE.EMPTY_LIST,
        OPCODE.MARK,
        [OPCODE.BINUNICODE8, ...eightByteLength, 0x68, 0x69],
        [OPCODE.BINBYTES8, ...eightByteLength, 0x01, 0x02],
        0x65,
        OPCODE.STOP,
      ),
      resolveTestGlobal,
    );

    expect(decoded).toEqual(['hi', Uint8Array.from([1, 2])]);
  });

  it('discards a group with POP_MARK', () => {
    const decoded = loadPickle(
      payload(
        [OPCODE.PROTO, 4],
        [OPCODE.BININT1, 7],
        OPCODE.MARK,
        [OPCODE.BININT1, 8],
        [OPCODE.BININT1, 9],
        OPCODE.POP_MARK,
        OPCODE.STOP,
      ),
      resolveTestGlobal,
    );

    expect(decoded).toBe(7);
  });

  it('builds a NEWOBJ_EX instance from its keyword arguments', () => {
    const seen: Array<ReadonlyMap<unknown, unknown>> = [];
    const decoded = loadPickle(
      payload(
        [OPCODE.PROTO, 4],
        shortUnicode('example.models'),
        shortUnicode('Widget'),
        OPCODE.STACK_GLOBAL,
        OPCODE.EMPTY_TUPLE,
        OPCODE.EMPTY_DICT,
        shortUnicode('label'),
        shortUnicode('left'),
        OPCODE.SETITEM,
        OPCODE.NEWOBJ_EX,
        OPCODE.STOP,
      ),
      () => ({
        create: (_args, kwargs) => {
          seen.push(kwargs);
          return new Map(kwargs);
        },
      }),
    );

    expect(decoded).toEqual(new Map([['label', 'left']]));
    expect(seen).toHaveLength(1);
  });

  it('lets a factory apply the BUILD state itself', () => {
    const decoded = loadPickle(
      payloadBytes(WIDGET_PAYLOAD),
      (): PickleObjectFactory => ({
        create: () => ({}),
        setState: (_instance, state) => asMap(state).get('__dict__'),
      }),
    );

    expect(decoded).toEqual(
      new Map<unknown, unknown>([
        ['label', 'left'],
        ['size', 3],
      ]),
    );
  });

  it('refuses a global the resolver rejects, and builds nothing', () => {
    const attempted: PickleGlobal[] = [];

    expect(() =>
      loadPickle(
        callGlobalPayload('builtins', 'eval', '1 + 1'),
        (pickleGlobal) => {
          attempted.push(pickleGlobal);
          throw new PickleSecurityError(
            `Refusing to load ${pickleGlobal.module}.${pickleGlobal.name}.`,
          );
        },
      ),
    ).toThrow(PickleSecurityError);

    expect(attempted).toEqual([{module: 'builtins', name: 'eval'}]);
  });

  it('reports the refused global with the code of a refusal', () => {
    let caught: unknown;
    try {
      load(
        Buffer.from(
          callGlobalPayload('os', 'system', 'echo unreached'),
        ).toString('base64'),
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PickleSecurityError);
    expect((caught as PickleError).code).toBe(PickleErrorCode.REFUSED_GLOBAL);
    expect((caught as Error).message).toContain('os.system');
  });

  it.each([
    ['DUP', OPCODE.DUP],
    ['PERSID', OPCODE.PERSID],
    ['BINPERSID', OPCODE.BINPERSID],
    ['INST', OPCODE.INST],
    ['OBJ', OPCODE.OBJ],
    ['EXT1', OPCODE.EXT1],
    ['STRING', OPCODE.STRING],
  ])('refuses the unsupported opcode %s by name', (name, opcode) => {
    expect(() =>
      loadPickle(payload([OPCODE.PROTO, 4], opcode), resolveTestGlobal),
    ).toThrowError(
      expect.objectContaining({
        code: PickleErrorCode.UNSUPPORTED_OPCODE,
        message: expect.stringContaining(name),
      }),
    );
  });

  it('refuses an opcode it has no name for', () => {
    expect(() =>
      loadPickle(payload([OPCODE.PROTO, 4], 0x01), resolveTestGlobal),
    ).toThrowError(
      expect.objectContaining({
        code: PickleErrorCode.UNSUPPORTED_OPCODE,
        message: expect.stringContaining('0x01'),
      }),
    );
  });

  it('refuses a protocol newer than it reads', () => {
    expect(() =>
      loadPickle(
        payload([OPCODE.PROTO, 6], OPCODE.NONE, OPCODE.STOP),
        resolveTestGlobal,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: PickleErrorCode.UNSUPPORTED_OPCODE,
        message: expect.stringContaining('protocol 6'),
      }),
    );
  });

  it('reports a payload that ends inside a value', () => {
    expect(() =>
      loadPickle(
        payload([OPCODE.PROTO, 4], [0x8c, 0x10, 0x61]),
        resolveTestGlobal,
      ),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.TRUNCATED_PAYLOAD}),
    );
  });

  it('reports a GLOBAL operand with no terminator', () => {
    expect(() =>
      loadPickle(
        payload(
          [OPCODE.PROTO, 2],
          OPCODE.GLOBAL,
          Array.from(Buffer.from('os')),
        ),
        resolveTestGlobal,
      ),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.TRUNCATED_PAYLOAD}),
    );
  });

  it('reports a length no reader can address', () => {
    expect(() =>
      loadPickle(
        payload(
          [OPCODE.PROTO, 4],
          [OPCODE.BINUNICODE8, 0, 0, 0, 0, 0, 0, 0, 0xff],
        ),
        resolveTestGlobal,
      ),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.TRUNCATED_PAYLOAD}),
    );
  });

  it('reports a memo slot the payload never wrote', () => {
    expect(() =>
      loadPickle(
        payload([OPCODE.PROTO, 4], [OPCODE.BINGET, 3], OPCODE.STOP),
        resolveTestGlobal,
      ),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNKNOWN_MEMO}),
    );
  });

  it('reports an opcode that reads more than the payload pushed', () => {
    expect(() =>
      loadPickle(payload([OPCODE.PROTO, 4], OPCODE.STOP), resolveTestGlobal),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.STACK_UNDERFLOW}),
    );
  });

  it('reports a MEMOIZE with nothing on the stack', () => {
    expect(() =>
      loadPickle(payload([OPCODE.PROTO, 4], OPCODE.MEMOIZE), resolveTestGlobal),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.STACK_UNDERFLOW}),
    );
  });

  it('reports a group that was never opened', () => {
    expect(() =>
      loadPickle(
        payload([OPCODE.PROTO, 4], OPCODE.EMPTY_LIST, 0x65),
        resolveTestGlobal,
      ),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.STACK_UNDERFLOW}),
    );
  });

  it('reports a global whose module is not a string', () => {
    expect(() =>
      loadPickle(
        payload(
          [OPCODE.PROTO, 4],
          OPCODE.NONE,
          OPCODE.NONE,
          OPCODE.STACK_GLOBAL,
        ),
        resolveTestGlobal,
      ),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });

  it('reports a REDUCE whose callable is not a resolved global', () => {
    expect(() =>
      loadPickle(
        payload(
          [OPCODE.PROTO, 4],
          OPCODE.NONE,
          OPCODE.EMPTY_TUPLE,
          OPCODE.REDUCE,
        ),
        resolveTestGlobal,
      ),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });

  it('reports a REDUCE whose arguments are not a tuple', () => {
    expect(() =>
      loadPickle(
        payload(
          [OPCODE.PROTO, 4],
          shortUnicode('builtins'),
          shortUnicode('list'),
          OPCODE.STACK_GLOBAL,
          OPCODE.NONE,
          OPCODE.REDUCE,
        ),
        resolveTestGlobal,
      ),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });

  it('reports a NEWOBJ_EX whose keyword arguments are not a dictionary', () => {
    expect(() =>
      loadPickle(
        payload(
          [OPCODE.PROTO, 4],
          shortUnicode('builtins'),
          shortUnicode('list'),
          OPCODE.STACK_GLOBAL,
          OPCODE.EMPTY_TUPLE,
          OPCODE.EMPTY_LIST,
          OPCODE.NEWOBJ_EX,
        ),
        resolveTestGlobal,
      ),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });

  it('reports a BUILD onto a value that takes no state', () => {
    expect(() =>
      loadPickle(
        payload(
          [OPCODE.PROTO, 4],
          OPCODE.NONE,
          OPCODE.EMPTY_DICT,
          OPCODE.BUILD,
        ),
        resolveTestGlobal,
      ),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });

  it('reports an APPEND onto a value that is not a list', () => {
    expect(() =>
      loadPickle(
        payload(
          [OPCODE.PROTO, 4],
          OPCODE.EMPTY_DICT,
          [OPCODE.BININT1, 1],
          0x61,
        ),
        resolveTestGlobal,
      ),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });

  it('reports an ADDITEMS onto a value that is not a set', () => {
    expect(() =>
      loadPickle(
        payload(
          [OPCODE.PROTO, 4],
          OPCODE.EMPTY_LIST,
          OPCODE.MARK,
          [OPCODE.BININT1, 1],
          OPCODE.ADDITEMS,
        ),
        resolveTestGlobal,
      ),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });

  it('reports a SETITEM onto a value that is not a dictionary', () => {
    expect(() =>
      loadPickle(
        payload(
          [OPCODE.PROTO, 4],
          OPCODE.EMPTY_SET,
          [OPCODE.BININT1, 1],
          [OPCODE.BININT1, 2],
          OPCODE.SETITEM,
        ),
        resolveTestGlobal,
      ),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });

  it('reports a SETITEMS with a key that has no value', () => {
    expect(() =>
      loadPickle(
        payload(
          [OPCODE.PROTO, 4],
          OPCODE.EMPTY_DICT,
          OPCODE.MARK,
          [OPCODE.BININT1, 1],
          0x75,
        ),
        resolveTestGlobal,
      ),
    ).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });
});

describe('dumpPickle', () => {
  it('round-trips every value kind through the reader', () => {
    const value = new Map<unknown, unknown>([
      ['none', null],
      ['true', true],
      ['false', false],
      ['byte_int', 200],
      ['short_int', 4242],
      ['int32', 123456789],
      ['negative', -7],
      ['big_int', 2n ** 80n],
      ['negative_big_int', -(2n ** 80n)],
      ['beyond_int32', 3000000000],
      ['float', 1.5],
      ['text', 'café ✓'],
      ['long_text', 'x'.repeat(400)],
      ['bytes', Uint8Array.from([0, 1, 254])],
      ['long_bytes', Uint8Array.from(Buffer.alloc(400, 7))],
      ['list', [1, 2, 3]],
      ['empty_list', []],
      ['set', new Set([1, 2])],
      ['empty_set', new Set()],
      ['empty_dict', new Map()],
      ['object', {nested: 'value'}],
    ]);

    const decoded = asMap(loadPickle(dumpPickle(value), resolveTestGlobal));

    expect(decoded.get('big_int')).toBe(2n ** 80n);
    expect(decoded.get('negative_big_int')).toBe(-(2n ** 80n));
    expect(decoded.get('beyond_int32')).toBe(3000000000);
    expect(decoded.get('bytes')).toEqual(Uint8Array.from([0, 1, 254]));
    expect(decoded.get('object')).toEqual(new Map([['nested', 'value']]));
    expect(decoded.get('set')).toEqual(new Set([1, 2]));
    expect(decoded.get('empty_set')).toEqual(new Set());
    expect(decoded.get('empty_dict')).toEqual(new Map());
    expect(decoded.get('long_text')).toBe('x'.repeat(400));
  });

  it('round-trips the integer widths at their boundaries', () => {
    const boundaries = [0, 255, 256, 65535, 65536, 2147483647, -2147483648];

    const decoded = loadPickle(dumpPickle(boundaries), resolveTestGlobal);

    expect(decoded).toEqual(boundaries);
  });

  it('round-trips a long whose magnitude needs a padding byte', () => {
    const values = [128n, -128n, -129n, 255n, -1n, 0n];

    const decoded = loadPickle(dumpPickle(values), resolveTestGlobal);

    expect(decoded).toEqual([128, -128, -129, 255, -1, 0]);
  });

  it('round-trips a long too large for the one-byte length prefix', () => {
    const huge = 2n ** 2048n;

    const decoded = loadPickle(dumpPickle([huge, -huge]), resolveTestGlobal);

    expect(decoded).toEqual([huge, -huge]);
  });

  it('writes an instance the reader rebuilds through its resolver', () => {
    const instance: PickleInstance = {
      kind: 'pickle-instance',
      global: {module: 'example.models', name: 'Widget'},
      args: [],
      state: new Map<unknown, unknown>([['label', 'left']]),
    };

    const decoded = loadPickle(dumpPickle(instance), resolveTestGlobal);

    expect(decoded).toEqual(new Map([['label', 'left']]));
  });

  it('writes the constructor arguments of an instance as a tuple', () => {
    const seen: unknown[][] = [];
    const instance: PickleInstance = {
      kind: 'pickle-instance',
      global: {module: 'example.models', name: 'Widget'},
      args: [1, 'two'],
      state: new Map(),
    };

    loadPickle(dumpPickle(instance), () => ({
      create: (args) => {
        seen.push([...args]);
        return new Map();
      },
    }));

    expect(seen).toEqual([[1, 'two']]);
  });

  it('reports a value that contains itself', () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);

    expect(() => dumpPickle(cycle)).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_VALUE}),
    );
  });

  it('reports a value the pickle format cannot hold', () => {
    expect(() => dumpPickle({missing: undefined})).toThrowError(
      expect.objectContaining({
        code: PickleErrorCode.UNSUPPORTED_VALUE,
        message: expect.stringContaining('undefined'),
      }),
    );
  });
});

describe('isPickleInstance', () => {
  it('accepts an instance and rejects the values it resembles', () => {
    const instance: PickleInstance = {
      kind: 'pickle-instance',
      global: {module: 'example.models', name: 'Widget'},
      args: [],
      state: null,
    };

    expect(isPickleInstance(instance)).toBe(true);
    expect(isPickleInstance({kind: 'other'})).toBe(false);
    expect(isPickleInstance(null)).toBe(false);
    expect(isPickleInstance('pickle-instance')).toBe(false);
  });
});
