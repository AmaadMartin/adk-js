/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  GlobalResolver,
  loadPickle,
  MAX_PICKLE_BYTES,
  MAX_PICKLE_STACK,
  PickleGlobal,
} from '../../src/utils/pickle_reader.js';
import {
  be64f,
  fromBase64,
  le32,
  le64,
  payload,
  STOP,
} from './pickle_payload_test_utils.js';

/** A resolver that refuses every name; used where none should be resolved. */
const REFUSE_ALL: GlobalResolver = (module, name) => {
  throw new Error(`unexpected global ${module}.${name}`);
};

/** Records the globals a payload names and builds an inert record for each. */
interface RecordedGlobal {
  module: string;
  name: string;
  args: unknown[];
}

function recordingResolver(seen: RecordedGlobal[]): GlobalResolver {
  return (module, name): PickleGlobal => ({
    construct(args: unknown[]): unknown {
      const record: RecordedGlobal = {module, name, args};
      seen.push(record);
      return record;
    },
  });
}

function load(data: Uint8Array): unknown {
  return loadPickle(data, REFUSE_ALL);
}

describe('loadPickle scalars', () => {
  it('reads NONE, NEWTRUE and NEWFALSE', () => {
    expect(load(payload(0x4e, STOP))).toBeNull();
    expect(load(payload(0x88, STOP))).toBe(true);
    expect(load(payload(0x89, STOP))).toBe(false);
  });

  it('reads the four binary integer widths', () => {
    expect(load(payload(0x4b, 7, STOP))).toBe(7);
    expect(load(payload(0x4d, 0x01, 0x02, STOP))).toBe(0x0201);
    expect(load(payload(0x4a, le32(0xfffffffe), STOP))).toBe(-2);
    expect(load(payload(0x4a, le32(70000), STOP))).toBe(70000);
  });

  it('reads LONG1 and LONG4 as little-endian two-s complement', () => {
    expect(load(payload(0x8a, 1, 0x05, STOP))).toBe(5);
    expect(load(payload(0x8a, 1, 0xfb, STOP))).toBe(-5);
    expect(load(payload(0x8a, 0, STOP))).toBe(0);
    // 2**70 needs nine bytes and does not fit a JS number.
    expect(load(payload(0x8a, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, STOP))).toBe(
      1180591620717411303424n,
    );
    expect(load(payload(0x8b, le32(2), 0x00, 0x01, STOP))).toBe(256);
  });

  it('reads BINFLOAT', () => {
    expect(load(payload(0x47, be64f(-1.25), STOP))).toBe(-1.25);
  });
});

describe('loadPickle strings and bytes', () => {
  it('reads every unicode width', () => {
    expect(load(payload(0x8c, 3, 'adk', STOP))).toBe('adk');
    expect(load(payload(0x58, le32(3), 'adk', STOP))).toBe('adk');
    expect(load(payload(0x8d, le64(3), 'adk', STOP))).toBe('adk');
  });

  it('decodes multi-byte UTF-8 by byte length, not character count', () => {
    expect(load(payload(0x8c, 3, 'né', STOP))).toBe('né');
  });

  it('reads every bytes width and BYTEARRAY8', () => {
    expect(load(payload(0x43, 2, 0x00, 0xff, STOP))).toEqual(
      Uint8Array.from([0x00, 0xff]),
    );
    expect(load(payload(0x42, le32(2), 0x01, 0x02, STOP))).toEqual(
      Uint8Array.from([1, 2]),
    );
    expect(load(payload(0x8e, le64(1), 0x09, STOP))).toEqual(
      Uint8Array.from([9]),
    );
    expect(load(payload(0x96, le64(2), 0x61, 0x62, STOP))).toEqual(
      Uint8Array.from([0x61, 0x62]),
    );
  });
});

describe('loadPickle containers', () => {
  it('builds a dict with SETITEM and SETITEMS', () => {
    const withSetItem = load(payload(0x7d, 0x8c, 1, 'a', 0x4b, 1, 0x73, STOP));
    expect(withSetItem).toEqual(new Map([['a', 1]]));

    const withSetItems = load(
      payload(
        0x7d,
        0x28,
        0x8c,
        1,
        'a',
        0x4b,
        1,
        0x8c,
        1,
        'b',
        0x4b,
        2,
        0x75,
        STOP,
      ),
    );
    expect(withSetItems).toEqual(
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
    );
  });

  it('keeps a non-string dict key distinct from its string spelling', () => {
    const dict = load(
      payload(
        0x7d,
        0x28,
        0x4b,
        1,
        0x8c,
        3,
        'int',
        0x8c,
        1,
        '1',
        0x8c,
        3,
        'str',
        0x75,
        STOP,
      ),
    );
    expect(dict).toEqual(
      new Map<unknown, unknown>([
        [1, 'int'],
        ['1', 'str'],
      ]),
    );
  });

  it('builds a list with APPEND and APPENDS', () => {
    expect(load(payload(0x5d, 0x4b, 1, 0x61, STOP))).toEqual([1]);
    expect(load(payload(0x5d, 0x28, 0x4b, 1, 0x4b, 2, 0x65, STOP))).toEqual([
      1, 2,
    ]);
  });

  it('builds every tuple width', () => {
    expect(load(payload(0x29, STOP))).toEqual([]);
    expect(load(payload(0x4b, 1, 0x85, STOP))).toEqual([1]);
    expect(load(payload(0x4b, 1, 0x4b, 2, 0x86, STOP))).toEqual([1, 2]);
    expect(load(payload(0x4b, 1, 0x4b, 2, 0x4b, 3, 0x87, STOP))).toEqual([
      1, 2, 3,
    ]);
    expect(
      load(payload(0x28, 0x4b, 1, 0x4b, 2, 0x4b, 3, 0x4b, 4, 0x74, STOP)),
    ).toEqual([1, 2, 3, 4]);
  });

  it('builds a set with ADDITEMS and a frozenset from a mark', () => {
    expect(load(payload(0x8f, 0x28, 0x4b, 1, 0x4b, 2, 0x90, STOP))).toEqual(
      new Set([1, 2]),
    );
    expect(load(payload(0x28, 0x4b, 3, 0x91, STOP))).toEqual(new Set([3]));
  });
});

describe('loadPickle memo', () => {
  it('shares one object between BINPUT and BINGET', () => {
    // memo[4] = [];  ([], [memo[4]])
    const result = load(
      payload(0x5d, 0x71, 4, 0x5d, 0x68, 4, 0x61, 0x86, STOP),
    ) as unknown[][];
    expect(result).toEqual([[], [[]]]);
    expect(result[1][0]).toBe(result[0]);
  });

  it('shares one object between LONG_BINPUT and LONG_BINGET', () => {
    expect(
      load(
        payload(
          0x8c,
          3,
          'adk',
          0x72,
          le32(70000),
          0x6a,
          le32(70000),
          0x86,
          STOP,
        ),
      ),
    ).toEqual(['adk', 'adk']);
  });

  it('numbers MEMOIZE entries in order', () => {
    expect(
      load(
        payload(0x8c, 1, 'x', 0x94, 0x8c, 1, 'y', 0x94, 0x68, 0, 0x87, STOP),
      ),
    ).toEqual(['x', 'y', 'x']);
  });

  it('rejects a reference to a memo entry that was never written', () => {
    expect(() => load(payload(0x68, 3, STOP))).toThrow(
      'referenced unset memo entry 3',
    );
  });
});

describe('loadPickle globals', () => {
  it('hands GLOBAL and STACK_GLOBAL to the resolver', () => {
    const seen: RecordedGlobal[] = [];
    loadPickle(
      payload(0x63, 'datetime\n', 'datetime\n', 0x29, 0x52, STOP),
      recordingResolver(seen),
    );
    expect(seen).toEqual([{module: 'datetime', name: 'datetime', args: []}]);

    seen.length = 0;
    loadPickle(
      payload(
        0x8c,
        8,
        'builtins',
        0x8c,
        3,
        'set',
        0x93,
        0x5d,
        0x85,
        0x52,
        STOP,
      ),
      recordingResolver(seen),
    );
    expect(seen).toEqual([{module: 'builtins', name: 'set', args: [[]]}]);
  });

  it('lets a refusing resolver abort the load', () => {
    expect(() =>
      load(payload(0x8c, 8, 'builtins', 0x8c, 4, 'exec', 0x93, STOP)),
    ).toThrow('unexpected global builtins.exec');
  });

  it('constructs through NEWOBJ and NEWOBJ_EX', () => {
    const seen: RecordedGlobal[] = [];
    loadPickle(
      payload(0x63, 'm\n', 'C\n', 0x4b, 1, 0x85, 0x81, STOP),
      recordingResolver(seen),
    );
    expect(seen).toEqual([{module: 'm', name: 'C', args: [1]}]);

    seen.length = 0;
    loadPickle(
      payload(0x63, 'm\n', 'C\n', 0x4b, 2, 0x85, 0x7d, 0x92, STOP),
      recordingResolver(seen),
    );
    expect(seen).toEqual([{module: 'm', name: 'C', args: [2]}]);
  });

  it('copies a BUILD state onto the object the resolver returned', () => {
    const seen: RecordedGlobal[] = [];
    const built = loadPickle(
      payload(
        0x63,
        'm\n',
        'C\n',
        0x29,
        0x81,
        0x7d,
        0x8c,
        3,
        'int',
        0x4b,
        7,
        0x73,
        0x62,
        STOP,
      ),
      recordingResolver(seen),
    );
    expect(built).toMatchObject({module: 'm', name: 'C', int: 7});
  });

  it('applies both halves of a (state, slotstate) BUILD pair', () => {
    const seen: RecordedGlobal[] = [];
    const built = loadPickle(
      payload(
        0x63,
        'm\n',
        'C\n',
        0x29,
        0x81,
        // ({'a': 1}, {'b': 2})
        0x7d,
        0x8c,
        1,
        'a',
        0x4b,
        1,
        0x73,
        0x7d,
        0x8c,
        1,
        'b',
        0x4b,
        2,
        0x73,
        0x86,
        0x62,
        STOP,
      ),
      recordingResolver(seen),
    );
    expect(built).toMatchObject({a: 1, b: 2});
  });

  it('ignores a non-string BUILD state key, which cannot name a property', () => {
    const seen: RecordedGlobal[] = [];
    const built = loadPickle(
      payload(
        0x63,
        'm\n',
        'C\n',
        0x29,
        0x81,
        0x7d,
        0x4b,
        1,
        0x4b,
        9,
        0x73,
        0x62,
        STOP,
      ),
      recordingResolver(seen),
    );
    expect(Object.keys(built as object)).toEqual(['module', 'name', 'args']);
  });

  it('leaves the object untouched for a null BUILD state', () => {
    const seen: RecordedGlobal[] = [];
    const built = loadPickle(
      payload(0x63, 'm\n', 'C\n', 0x29, 0x81, 0x4e, 0x62, STOP),
      recordingResolver(seen),
    );
    expect(built).toEqual({module: 'm', name: 'C', args: []});
  });
});

describe('loadPickle rejects malformed payloads', () => {
  it('rejects an unsupported opcode', () => {
    // 0x2b is POP_MARK, which this reader does not implement.
    expect(() => load(payload(0x4e, 0x2b, STOP))).toThrow(
      'Unsupported pickle opcode 0x2b at byte 1',
    );
  });

  it('rejects a payload that ends before its STOP', () => {
    expect(() => load(payload(0x4e))).toThrow('expected another opcode');
  });

  it('rejects a truncated length-prefixed run', () => {
    expect(() => load(payload(0x8c, 9, 'adk', STOP))).toThrow(
      'wanted 9 bytes at 2',
    );
    expect(() => load(payload(0x4a, 0x01))).toThrow('wanted 4 bytes at 1');
  });

  it('rejects an unterminated line', () => {
    expect(() => load(payload(0x63, 'datetime'))).toThrow('unterminated line');
  });

  it('rejects STOP on an empty stack', () => {
    expect(() => load(payload(STOP))).toThrow('the stack is empty');
  });

  it('rejects a mutation opcode applied to the wrong container', () => {
    expect(() => load(payload(0x5d, 0x4b, 1, 0x4b, 1, 0x73, STOP))).toThrow(
      'SETITEM applied to a value that is not a dict',
    );
    expect(() => load(payload(0x7d, 0x4b, 1, 0x61, STOP))).toThrow(
      'APPEND applied to a value that is not a list',
    );
    expect(() => load(payload(0x5d, 0x28, 0x4b, 1, 0x90, STOP))).toThrow(
      'ADDITEMS applied to a value that is not a set',
    );
    expect(() => load(payload(0x5d, 0x7d, 0x62, STOP))).toThrow(
      'BUILD applied to a value that is not an object',
    );
    expect(() => load(payload(0x5d, 0x4b, 1, 0x62, STOP))).toThrow(
      'BUILD expected a dict state',
    );
  });

  it('rejects a global application whose operands are wrong', () => {
    expect(() => load(payload(0x4b, 1, 0x4b, 2, 0x52, STOP))).toThrow(
      'applied a global to a non-tuple',
    );
    expect(() => load(payload(0x4b, 1, 0x29, 0x52, STOP))).toThrow(
      'applied a value that is not a global',
    );
    expect(() => load(payload(0x4b, 1, 0x4b, 2, 0x93, STOP))).toThrow(
      'STACK_GLOBAL expected two strings',
    );
  });

  it('rejects a group that was never opened', () => {
    expect(() => load(payload(0x74, STOP))).toThrow(
      'closed a group that was never opened',
    );
  });

  it('rejects a tuple wider than the stack', () => {
    expect(() => load(payload(0x4b, 1, 0x87, STOP))).toThrow(
      'the stack is too short',
    );
  });

  it('rejects a memo write with nothing on the stack', () => {
    expect(() => load(payload(0x71, 0, STOP))).toThrow('the stack is empty');
  });

  it('rejects a payload that grows the stack past MAX_PICKLE_STACK', () => {
    // One NONE per stack entry, so the payload stays well under the byte cap.
    const nones = new Uint8Array(MAX_PICKLE_STACK + 1).fill(0x4e);
    expect(() => load(payload(nones, STOP))).toThrow(
      `Pickle stack exceeded ${MAX_PICKLE_STACK} entries`,
    );
  });

  it('rejects a payload larger than MAX_PICKLE_BYTES', () => {
    const oversized = new Uint8Array(MAX_PICKLE_BYTES + 1);
    expect(() => load(oversized)).toThrow(
      `is ${MAX_PICKLE_BYTES + 1} bytes, over the ${MAX_PICKLE_BYTES}-byte limit`,
    );
  });

  it('rejects a 64-bit length prefix beyond MAX_PICKLE_BYTES', () => {
    expect(() => load(payload(0x8d, le64(MAX_PICKLE_BYTES + 1), STOP))).toThrow(
      `over the ${MAX_PICKLE_BYTES}-byte limit`,
    );
  });
});

describe('loadPickle reads real CPython payloads', () => {
  // pickle.dumps({'name': 'adk', 'sizes': [1, 2, 3], 'ok': True,
  //               'none': None, 'ratio': 0.5}, protocol=P) on CPython 3.13.
  // Protocol 2 is the oldest this reader accepts, and 5 the newest; the two
  // spell globals and the memo differently.
  const SAME_OBJECT_BY_PROTOCOL: ReadonlyArray<[number, string]> = [
    [
      2,
      'gAJ9cQAoWAQAAABuYW1lcQFYAwAAAGFka3ECWAUAAABzaXplc3EDXXEEKEsBSwJLA2VYAgAAAG9rcQWIWAQAAABub25lcQZOWAUAAAByYXRpb3EHRz/gAAAAAAAAdS4=',
    ],
    [
      5,
      'gAWVQwAAAAAAAAB9lCiMBG5hbWWUjANhZGuUjAVzaXplc5RdlChLAUsCSwNljAJva5SIjARub25llE6MBXJhdGlvlEc/4AAAAAAAAHUu',
    ],
  ];

  it.each(SAME_OBJECT_BY_PROTOCOL)(
    'reads the same dict from a protocol %i payload',
    (_protocol, base64Payload) => {
      expect(load(fromBase64(base64Payload))).toEqual(
        new Map<unknown, unknown>([
          ['name', 'adk'],
          ['sizes', [1, 2, 3]],
          ['ok', true],
          ['none', null],
          ['ratio', 0.5],
        ]),
      );
    },
  );
});
