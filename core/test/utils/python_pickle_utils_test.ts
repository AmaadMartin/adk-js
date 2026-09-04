/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  PickleErrorCode,
  PickleObjectFactory,
} from '../../src/utils/pickle_utils.js';
import {
  pickleToPlain,
  plainToPickle,
  PYTHON_STDLIB_PICKLE_FACTORIES,
} from '../../src/utils/python_pickle_utils.js';

const NO_KEYWORDS: ReadonlyMap<unknown, unknown> = new Map();

function factory(name: string): PickleObjectFactory {
  const found = PYTHON_STDLIB_PICKLE_FACTORIES.get(name);
  if (!found) {
    expect.fail(`No factory declared for ${name}.`);
  }
  return found;
}

function build(name: string, ...args: unknown[]): unknown {
  return factory(name).create(args, NO_KEYWORDS);
}

function setState(name: string, state: unknown): unknown {
  const target = factory(name);
  if (!target.setState) {
    expect.fail(`${name} declares no setState.`);
  }
  return target.setState(target.create([], NO_KEYWORDS), state);
}

describe('PYTHON_STDLIB_PICKLE_FACTORIES', () => {
  it('builds each container from its argument, and empty with none', () => {
    expect(build('builtins.dict', new Map([['a', 1]]))).toEqual(
      new Map([['a', 1]]),
    );
    expect(build('builtins.dict')).toEqual(new Map());
    expect(build('builtins.list', [1, 2])).toEqual([1, 2]);
    expect(build('builtins.list')).toEqual([]);
    expect(build('builtins.tuple', new Set([1]))).toEqual([1]);
    expect(build('builtins.tuple')).toEqual([]);
    expect(build('builtins.set', [1, 1, 2])).toEqual(new Set([1, 2]));
    expect(build('builtins.set')).toEqual(new Set());
    expect(build('collections.OrderedDict', new Map([['a', 1]]))).toEqual(
      new Map([['a', 1]]),
    );
    expect(build('collections.defaultdict', build('builtins.list'))).toEqual(
      new Map(),
    );
  });

  it('builds a container from the keys of a dictionary argument', () => {
    expect(build('builtins.list', new Map([['a', 1]]))).toEqual(['a']);
  });

  it('coerces each primitive, and defaults with no argument', () => {
    expect(build('builtins.str', 5)).toBe('5');
    expect(build('builtins.str')).toBe('');
    expect(build('builtins.int', 7)).toBe(7);
    expect(build('builtins.int', 2n ** 70n)).toBe(Number(2n ** 70n));
    expect(build('builtins.int')).toBe(0);
    expect(build('builtins.float', 1.5)).toBe(1.5);
    expect(build('builtins.float')).toBe(0);
    expect(build('builtins.bool', 1)).toBe(true);
    expect(build('builtins.bool')).toBe(false);
    expect(build('builtins.bytes', Uint8Array.from([1]))).toEqual(
      Uint8Array.from([1]),
    );
    expect(build('builtins.bytes')).toEqual(new Uint8Array(0));
    expect(build('builtins.bytearray', Uint8Array.from([2]))).toEqual(
      Uint8Array.from([2]),
    );
    expect(build('builtins.bytearray')).toEqual(new Uint8Array(0));
    expect(build('builtins.complex', 1, 2)).toEqual({real: 1, imag: 2});
  });

  it('builds a path from its parts, and the current directory from none', () => {
    expect(build('pathlib.PurePosixPath', '/data/x.txt')).toBe('/data/x.txt');
    expect(build('pathlib._local.PosixPath', 'a', 'b')).toBe('a/b');
    expect(build('pathlib.PureWindowsPath', 'a', 'b')).toBe('a\\b');
    expect(build('pathlib._local.WindowsPath', 'C:\\a')).toBe('C:\\a');
    expect(build('pathlib.PurePosixPath')).toBe('.');
  });

  it('builds a timedelta and a timezone as milliseconds', () => {
    expect(build('datetime.timedelta', 1, 2, 3000)).toBe(86_402_003);
    expect(build('datetime.timezone', 18_000_000)).toBe(18_000_000);
    expect(build('datetime.timezone', 18_000_000, 'UTC+05:00')).toBe(
      18_000_000,
    );
  });

  it('keeps the fold bit out of a datetime and a time', () => {
    const foldedDate = Uint8Array.from([
      0x07,
      0xea,
      0x01 | 0x80,
      0x02,
      0x03,
      0x04,
      0x05,
      0x00,
      0x00,
      0x00,
    ]);
    const foldedTime = Uint8Array.from([
      0x0c | 0x80,
      0x1e,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);

    expect(build('datetime.datetime', foldedDate)).toEqual(
      new Date('2026-01-02T03:04:05.000Z'),
    );
    expect(build('datetime.time', foldedTime)).toBe('12:30:00.000000');
  });

  it('renders a uuid from the integer its state carries', () => {
    const asNumber = setState('uuid.UUID', new Map([['int', 1]]));
    const asBigInt = setState(
      'uuid.UUID',
      new Map([['int', 0x12345678123456781234567812345678n]]),
    );

    expect(asNumber).toBe('00000000-0000-0000-0000-000000000001');
    expect(asBigInt).toBe('12345678-1234-5678-1234-567812345678');
  });

  it('reports a datetime state of the wrong size', () => {
    expect(() => build('datetime.date', Uint8Array.from([1, 2]))).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
    expect(() => build('datetime.time', 'not bytes')).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });

  it('reports an argument of the wrong kind', () => {
    expect(() => build('builtins.int', 'seven')).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
    expect(() => build('decimal.Decimal', 1.5)).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
    expect(() => build('builtins.list', 5)).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
    expect(() => build('builtins.dict', [1, 2])).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
    expect(() => build('builtins.bytes', 'text')).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
    expect(() => build('builtins.bytearray', 'text')).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });

  it('reports a uuid state that carries no integer', () => {
    expect(() => setState('uuid.UUID', new Map())).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
    expect(() => setState('uuid.UUID', 'not a dictionary')).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });
});

describe('pickleToPlain', () => {
  it('converts a dictionary, a set and a list', () => {
    const value = new Map<unknown, unknown>([
      ['nested', new Map([['a', 1]])],
      ['set', new Set([1, 2])],
      ['list', [new Map([['b', 2]])]],
      [7, 'numeric key'],
    ]);

    expect(pickleToPlain(value)).toEqual({
      nested: {a: 1},
      set: [1, 2],
      list: [{b: 2}],
      '7': 'numeric key',
    });
  });

  it('leaves a value with no container to convert', () => {
    const bytes = Uint8Array.from([1]);

    expect(pickleToPlain(bytes)).toBe(bytes);
    expect(pickleToPlain('text')).toBe('text');
    expect(pickleToPlain(null)).toBeNull();
  });
});

describe('plainToPickle', () => {
  it('converts an object to a dictionary and drops an undefined property', () => {
    expect(
      plainToPickle({kept: 1, dropped: undefined, nested: {a: [1]}}),
    ).toEqual(
      new Map<unknown, unknown>([
        ['kept', 1],
        ['nested', new Map([['a', [1]]])],
      ]),
    );
  });

  it('writes an undefined element as null, as JSON.stringify does', () => {
    expect(plainToPickle([1, undefined])).toEqual([1, null]);
    expect(plainToPickle(undefined)).toBeNull();
  });

  it('writes a Date as its ISO string', () => {
    expect(plainToPickle(new Date('2026-01-02T03:04:05.000Z'))).toBe(
      '2026-01-02T03:04:05.000Z',
    );
  });

  it('leaves a value the writer already understands', () => {
    const bytes = Uint8Array.from([1]);
    const set = new Set([1]);
    const map = new Map([['a', 1]]);

    expect(plainToPickle(bytes)).toBe(bytes);
    expect(plainToPickle(set)).toBe(set);
    expect(plainToPickle(map)).toBe(map);
    expect(plainToPickle(5)).toBe(5);
  });
});
