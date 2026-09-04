/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  isPlainObject,
  loadPickle,
  Opcode,
} from '../../src/utils/pickle_reader.js';
import {dumpPydanticModel} from '../../src/utils/pickle_writer.js';

const MODULE = 'google.adk.events.event_actions';
const CLASS = 'EventActions';

/**
 * Reads a payload back as the field dictionary it carries.
 *
 * The reader hands a `NEWOBJ`/`BUILD` pair to the resolver, so the resolver
 * builds a plain record and `BUILD` copies the state onto it. That state is
 * the four-key Pydantic dict, whose `__dict__` holds the fields.
 */
function fieldsOf(payload: Uint8Array): Map<unknown, unknown> {
  const state = stateOf(payload)['__dict__'];
  if (!(state instanceof Map)) {
    expect.fail('The payload carries no __dict__ map.');
  }
  return state;
}

/** Reads the four-key state dictionary a payload's `BUILD` applies. */
function stateOf(payload: Uint8Array): Record<string, unknown> {
  const decoded = loadPickle(payload, () => ({construct: () => ({})}));
  if (!isPlainObject(decoded)) {
    expect.fail('The payload does not decode to an object.');
  }
  return decoded;
}

/** Reads one field out of a payload. */
function fieldOf(payload: Uint8Array, name: string): unknown {
  return fieldsOf(payload).get(name);
}

describe('dumpPydanticModel', () => {
  it('writes a null-prototype map as a dict', () => {
    // `trimTempDeltaState` builds `stateDelta` with a null prototype so a
    // `__proto__` key cannot re-parent it, and those actions reach the writer
    // on the legacy v0 write path.
    const nested: Record<string, unknown> = Object.create(null);
    nested['topic'] = 'pickles';

    const payload = dumpPydanticModel(MODULE, CLASS, {state_delta: nested});

    expect(fieldOf(payload, 'state_delta')).toEqual(
      new Map([['topic', 'pickles']]),
    );
  });

  it('opens with the protocol 4 header', () => {
    const payload = dumpPydanticModel(MODULE, CLASS, {});

    expect(payload[0]).toBe(Opcode.PROTO);
    expect(payload[1]).toBe(4);
    expect(payload[payload.length - 1]).toBe(Opcode.STOP);
  });

  it('names the class through STACK_GLOBAL and nothing else', () => {
    const named: string[] = [];
    loadPickle(dumpPydanticModel(MODULE, CLASS, {}), (module, name) => {
      named.push(`${module}.${name}`);
      return {construct: () => ({})};
    });

    expect(named).toEqual([`${MODULE}.${CLASS}`]);
  });

  it('writes the four keys Pydantic __setstate__ reads', () => {
    const state = stateOf(dumpPydanticModel(MODULE, CLASS, {escalate: true}));

    expect(Object.keys(state).sort()).toEqual([
      '__dict__',
      '__pydantic_extra__',
      '__pydantic_fields_set__',
      '__pydantic_private__',
    ]);
  });

  it('records only the present fields in __pydantic_fields_set__', () => {
    const state = stateOf(
      dumpPydanticModel(MODULE, CLASS, {
        escalate: true,
        transfer_to_agent: undefined,
        state_delta: {},
      }),
    );
    const fieldsSet = state['__pydantic_fields_set__'];
    if (!(fieldsSet instanceof Set)) {
      expect.fail('The payload carries no __pydantic_fields_set__ set.');
    }

    expect([...fieldsSet].sort()).toEqual(['escalate', 'state_delta']);
  });

  it('leaves an undefined field out of the state dictionary', () => {
    const fields = fieldsOf(
      dumpPydanticModel(MODULE, CLASS, {escalate: undefined}),
    );

    expect(fields.size).toBe(0);
  });

  it('writes null as None', () => {
    expect(
      fieldOf(dumpPydanticModel(MODULE, CLASS, {a: null}), 'a'),
    ).toBeNull();
  });

  it('writes both boolean values', () => {
    const fields = fieldsOf(
      dumpPydanticModel(MODULE, CLASS, {yes: true, no: false}),
    );

    expect(fields.get('yes')).toBe(true);
    expect(fields.get('no')).toBe(false);
  });

  it.each([
    ['a one-byte integer', 0, Opcode.BININT1],
    ['the widest one-byte integer', 255, Opcode.BININT1],
    ['a two-byte integer', 256, Opcode.BININT2],
    ['the widest two-byte integer', 65535, Opcode.BININT2],
    ['a four-byte integer', 65536, Opcode.BININT],
    ['a negative integer', -1, Opcode.BININT],
    ['the narrowest four-byte integer', -0x80000000, Opcode.BININT],
    ['the widest four-byte integer', 0x7fffffff, Opcode.BININT],
    ['an integer past four bytes', 2 ** 40, Opcode.LONG1],
    ['an integer whose top byte needs a sign pad', 0xffffffff, Opcode.LONG1],
    ['a negative integer past four bytes', -(2 ** 40), Opcode.LONG1],
    [
      'a negative integer whose top byte is already signed',
      -(2 ** 39),
      Opcode.LONG1,
    ],
  ])('round-trips %s with the narrowest opcode', (_name, value, opcode) => {
    const payload = dumpPydanticModel(MODULE, CLASS, {n: value});

    expect(payload).toContain(opcode);
    expect(fieldOf(payload, 'n')).toBe(value);
  });

  it('writes a non-integral number as a float', () => {
    const payload = dumpPydanticModel(MODULE, CLASS, {n: -0.125});

    expect(payload).toContain(Opcode.BINFLOAT);
    expect(fieldOf(payload, 'n')).toBe(-0.125);
  });

  it('round-trips a string longer than a one-byte length prefix', () => {
    const long = 'a'.repeat(300);

    const payload = dumpPydanticModel(MODULE, CLASS, {[long]: long});

    expect(payload).toContain(Opcode.BINUNICODE);
    expect(fieldOf(payload, long)).toBe(long);
  });

  it('round-trips a string whose characters need several UTF-8 bytes', () => {
    expect(
      fieldOf(dumpPydanticModel(MODULE, CLASS, {s: 'héllo 😀'}), 's'),
    ).toBe('héllo 😀');
  });

  it.each([
    ['a short byte string', 4],
    ['a byte string past a one-byte length prefix', 300],
  ])('round-trips %s', (_name, length) => {
    const bytes = Uint8Array.from({length}, (_unused, index) => index % 256);

    const decoded = fieldOf(dumpPydanticModel(MODULE, CLASS, {b: bytes}), 'b');

    expect(decoded).toEqual(bytes);
  });

  it('round-trips a byte string held in a view over a larger buffer', () => {
    const view = new Uint8Array([1, 2, 3, 4, 5]).subarray(1, 4);

    expect(fieldOf(dumpPydanticModel(MODULE, CLASS, {b: view}), 'b')).toEqual(
      Uint8Array.from([2, 3, 4]),
    );
  });

  it('round-trips an empty and a populated list', () => {
    const fields = fieldsOf(
      dumpPydanticModel(MODULE, CLASS, {empty: [], full: [1, 'two', null]}),
    );

    expect(fields.get('empty')).toEqual([]);
    expect(fields.get('full')).toEqual([1, 'two', null]);
  });

  it('round-trips an empty and a nested object', () => {
    const fields = fieldsOf(
      dumpPydanticModel(MODULE, CLASS, {
        empty: {},
        nested: {inner: {leaf: [true]}},
      }),
    );

    expect(fields.get('empty')).toEqual(new Map());
    expect(fields.get('nested')).toEqual(
      new Map([['inner', new Map([['leaf', [true]]])]]),
    );
  });

  it('leaves an undefined value out of a nested object', () => {
    const nested = fieldOf(
      dumpPydanticModel(MODULE, CLASS, {o: {kept: 1, dropped: undefined}}),
      'o',
    );

    expect(nested).toEqual(new Map([['kept', 1]]));
  });

  it('grows past its initial capacity', () => {
    const wide = Object.fromEntries(
      Array.from({length: 200}, (_unused, index) => [`k${index}`, index]),
    );

    expect(fieldsOf(dumpPydanticModel(MODULE, CLASS, wide)).size).toBe(200);
  });

  it.each([
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a function', () => undefined],
    ['a symbol', Symbol('nope')],
    ['a bigint', 1n],
  ])('refuses to write %s', (_name, value) => {
    expect(() => dumpPydanticModel(MODULE, CLASS, {bad: value})).toThrowError(
      /Cannot write .* as a pickled value/,
    );
  });

  it('names the offending class when it refuses a value', () => {
    expect(() =>
      dumpPydanticModel(MODULE, CLASS, {bad: new Date(0)}),
    ).toThrowError(/an instance of Date/);
  });

  it('refuses an object with no class to name', () => {
    // A null prototype is a dict and is written as one, so the unnameable
    // value here is an object whose own prototype has none.
    const unnameable: unknown = Object.create(Object.create(null));

    expect(() =>
      dumpPydanticModel(MODULE, CLASS, {bad: unnameable}),
    ).toThrowError(/an instance of an anonymous class/);
  });
});
