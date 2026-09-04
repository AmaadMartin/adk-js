/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {loadEventActions} from '../../src/sessions/restricted_pickle.js';
import {fromBase64, payload, STOP} from '../utils/pickle_payload_test_utils.js';
import {
  ESCALATE,
  EVIL_EXEC,
  NESTED,
  PROTOCOL_2,
  SIMPLE_STATE_DELTA,
  STATE_AND_ARTIFACT,
} from './pickled_actions_fixtures.js';

/**
 * Payloads that only this file needs, generated the same way as the shared
 * fixtures. See the header of `pickled_actions_fixtures.ts`.
 */

/** `state_delta` holding one of every stdlib type the allowlist admits. */
const STDLIB_STATE_DELTA =
  'gAWV2wMAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwSc2tpcF9zdW1tYXJpemF0aW9ulE6MC3N0YXRlX2RlbHRhlH2UKIwEZGF0ZZSMCGRhdGV0aW1llIwEZGF0ZZSTlEMEB+oBApSFlFKUjAR0aW1llGgLjAR0aW1llJOUQwYBAgMAAASUhZRSlIwKcGxhaW5fdGltZZRoE0MGAQIDAAAAlIWUUpSMCGR1cmF0aW9ulGgLjAl0aW1lZGVsdGGUk5RLAUsCSwOHlFKUjA16ZXJvX2R1cmF0aW9ulGgdSwBLAEsAh5RSlIwFcHJpY2WUjAdkZWNpbWFslIwHRGVjaW1hbJSTlIwEMS4yNZSFlFKUjANydW6UjAR1dWlklIwEVVVJRJSTlCmBlH2UjANpbnSUihB4VjQSeFY0EnhWNBJ4VjQSc2KMB29yZGVyZWSUjAtjb2xsZWN0aW9uc5SMC09yZGVyZWREaWN0lJOUKVKUKIwBYZRLAYwBYpRLAnWMB2NvdW50ZWSUjAtjb2xsZWN0aW9uc5SMC2RlZmF1bHRkaWN0lJOUjAhidWlsdGluc5SMBGxpc3SUk5SFlFKUaDZdlEsBYXOMBHRhZ3OUj5QojAF4lJCMBmZyb3plbpQojAF5lJGUjARwYWlylEsBSwKGlIwDcmF3lEMCYWKUjARodWdllIoJAAAAAAAAAABAjAVuYWl2ZZRoC4wIZGF0ZXRpbWWUk5RDCgfqAQEMHgAAAACUhZRSlIwGb2Zmc2V0lGhPQwoH6gEBDB4AAAAAlGgLjAh0aW1lem9uZZSTlGgdSwBNWE1LAIeUUpSFlFKUhpRSlIwGYmVoaW5klGhPQwoH6gEBDB4AAAAAlGhWaB1K/////0ooBAEASwCHlFKUhZRSlIaUUpSMBm1pY3Jvc5RoT0MKB+oBAQweAAHiQJRoVmgihZRSlIaUUpR1jA5hcnRpZmFjdF9kZWx0YZR9lIwRdHJhbnNmZXJfdG9fYWdlbnSUTowIZXNjYWxhdGWUTowWcmVxdWVzdGVkX2F1dGhfY29uZmlnc5R9lIwccmVxdWVzdGVkX3Rvb2xfY29uZmlybWF0aW9uc5R9lIwKY29tcGFjdGlvbpROjBFyZW5kZXJfdWlfd2lkZ2V0c5RdlHWMEl9fcHlkYW50aWNfZXh0cmFfX5ROjBdfX3B5ZGFudGljX2ZpZWxkc19zZXRfX5SPlChoCJCMFF9fcHlkYW50aWNfcHJpdmF0ZV9flE51Yi4=';

/** `requested_auth_configs` holding an `AuthConfig` with a FastAPI scheme. */
const AUTH_CONFIG =
  'gAWVKwIAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwSc2tpcF9zdW1tYXJpemF0aW9ulE6MC3N0YXRlX2RlbHRhlH2UjA5hcnRpZmFjdF9kZWx0YZR9lIwRdHJhbnNmZXJfdG9fYWdlbnSUTowIZXNjYWxhdGWUTowWcmVxdWVzdGVkX2F1dGhfY29uZmlnc5R9lIwHZmMtYXV0aJSMGWdvb2dsZS5hZGsuYXV0aC5hdXRoX3Rvb2yUjApBdXRoQ29uZmlnlJOUKYGUfZQoaAV9lCiMC2F1dGhfc2NoZW1llIwWZmFzdGFwaS5vcGVuYXBpLm1vZGVsc5SMCkhUVFBCZWFyZXKUk5QpgZR9lChoBX2UKIwGc2NoZW1llIwGYmVhcmVylIwFdHlwZV+UjARodHRwlHWMEl9fcHlkYW50aWNfZXh0cmFfX5ROjBdfX3B5ZGFudGljX2ZpZWxkc19zZXRfX5SPlIwUX19weWRhbnRpY19wcml2YXRlX1+UTnVijA5jcmVkZW50aWFsX2tleZSMAWuUdWgiTmgjj5QoaCZoF5BoJU51YnOMHHJlcXVlc3RlZF90b29sX2NvbmZpcm1hdGlvbnOUfZSMCmNvbXBhY3Rpb26UTowRcmVuZGVyX3VpX3dpZGdldHOUXZR1aCJOaCOPlChoDpBoJU51Yi4=';

/** `render_ui_widgets`, a field adk-js does not model. */
const UI_WIDGET =
  'gAWV6gEAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwSc2tpcF9zdW1tYXJpemF0aW9ulE6MC3N0YXRlX2RlbHRhlH2UjA5hcnRpZmFjdF9kZWx0YZR9lIwRdHJhbnNmZXJfdG9fYWdlbnSUTowIZXNjYWxhdGWUTowWcmVxdWVzdGVkX2F1dGhfY29uZmlnc5R9lIwccmVxdWVzdGVkX3Rvb2xfY29uZmlybWF0aW9uc5R9lIwKY29tcGFjdGlvbpROjBFyZW5kZXJfdWlfd2lkZ2V0c5RdlIwbZ29vZ2xlLmFkay5ldmVudHMudWlfd2lkZ2V0lIwIVWlXaWRnZXSUk5QpgZR9lChoBX2UKIwCaWSUjAh3aWRnZXQtMZSMCHByb3ZpZGVylIwDbWNwlIwHcGF5bG9hZJR9lIwMcmVzb3VyY2VfdXJplIwLdWk6Ly93aWRnZXSUc3WMEl9fcHlkYW50aWNfZXh0cmFfX5ROjBdfX3B5ZGFudGljX2ZpZWxkc19zZXRfX5SPlChoHWgfaBuQjBRfX3B5ZGFudGljX3ByaXZhdGVfX5ROdWJhdWgjTmgkj5QoaBOQaCZOdWIu';

/** A datetime whose `tzinfo` is a `zoneinfo.ZoneInfo`, not a fixed offset. */
const ZONEINFO_TZ =
  'gAWV1gEAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwSc2tpcF9zdW1tYXJpemF0aW9ulE6MC3N0YXRlX2RlbHRhlH2UjAJhdJSMCGRhdGV0aW1llIwIZGF0ZXRpbWWUk5RDCgfqAQEMHgAAAACUjAhidWlsdGluc5SMB2dldGF0dHKUk5SMCHpvbmVpbmZvlIwIWm9uZUluZm+Uk5SMCV91bnBpY2tsZZSGlFKUjAxBc2lhL0tvbGthdGGUSwGGlFKUhpRSlHOMDmFydGlmYWN0X2RlbHRhlH2UjBF0cmFuc2Zlcl90b19hZ2VudJROjAhlc2NhbGF0ZZROjBZyZXF1ZXN0ZWRfYXV0aF9jb25maWdzlH2UjBxyZXF1ZXN0ZWRfdG9vbF9jb25maXJtYXRpb25zlH2UjApjb21wYWN0aW9ulE6MEXJlbmRlcl91aV93aWRnZXRzlF2UdYwSX19weWRhbnRpY19leHRyYV9flE6MF19fcHlkYW50aWNfZmllbGRzX3NldF9flI+UKGgIkIwUX19weWRhbnRpY19wcml2YXRlX1+UTnViLg==';

/** `pickle.dumps([1, 2, 3])`: a payload whose root is not an actions object. */
const NOT_AN_OBJECT = 'gAWVCwAAAAAAAABdlChLAUsCSwNlLg==';

/** Opcode bytes for a `GLOBAL module\nname\n` reference. */
function globalRef(module: string, name: string): Uint8Array {
  return payload(0x63, `${module}\n`, `${name}\n`);
}

/** A payload naming one global, applied to the arguments given as opcodes. */
function applied(
  module: string,
  name: string,
  ...args: Array<number | string | Uint8Array>
): Uint8Array {
  return payload(globalRef(module, name), ...args, 0x52, STOP);
}

describe('loadEventActions', () => {
  it('decodes a state delta written by adk-python', () => {
    const actions = loadEventActions(fromBase64(SIMPLE_STATE_DELTA));
    expect(actions.stateDelta).toEqual({skey: 4});
    expect(actions.artifactDelta).toEqual({});
    expect(actions.requestedAuthConfigs).toEqual({});
    expect(actions.requestedToolConfirmations).toEqual({});
  });

  it('reads a protocol 2 payload the same way as a protocol 5 one', () => {
    expect(loadEventActions(fromBase64(PROTOCOL_2))).toEqual(
      loadEventActions(fromBase64(SIMPLE_STATE_DELTA)),
    );
  });

  it('decodes the state and artifact deltas together', () => {
    const actions = loadEventActions(fromBase64(STATE_AND_ARTIFACT));
    expect(actions.stateDelta).toEqual({skey: 'updated'});
    expect(actions.artifactDelta).toEqual({'artifact.txt': 2});
  });

  it('decodes a boolean scalar field', () => {
    expect(loadEventActions(fromBase64(ESCALATE)).escalate).toBe(true);
  });

  it('decodes nested ADK and google.genai models', () => {
    const actions = loadEventActions(fromBase64(NESTED));
    expect(actions.requestedToolConfirmations['fc-confirm'].hint).toBe(
      'Authorize execution?',
    );
    expect(actions).toMatchObject({
      compaction: {
        startTimestamp: 1,
        endTimestamp: 2,
        compactedContent: {parts: [{text: 'summary'}], role: 'model'},
      },
    });
  });

  it('admits an auth config by module, keeping its keys verbatim', () => {
    const actions = loadEventActions(fromBase64(AUTH_CONFIG));
    expect(actions.requestedAuthConfigs).toEqual({
      'fc-auth': {
        // `actions.requested_auth_configs` is user data the repository
        // preserves verbatim, so the FastAPI scheme keeps adk-python's keys.
        'auth_scheme': {scheme: 'bearer', type_: 'http'},
        'credential_key': 'k',
      },
    });
  });

  it('carries a field adk-js does not model rather than dropping it', () => {
    expect(loadEventActions(fromBase64(UI_WIDGET))).toMatchObject({
      renderUiWidgets: [
        {
          id: 'widget-1',
          provider: 'mcp',
          payload: {resourceUri: 'ui://widget'},
        },
      ],
    });
  });
});

describe('loadEventActions stdlib types', () => {
  const actions = loadEventActions(fromBase64(STDLIB_STATE_DELTA));

  it('formats every temporal type the way pydantic JSON mode does', () => {
    expect(actions.stateDelta).toMatchObject({
      'date': '2026-01-02',
      'time': '01:02:03.000004',
      'plain_time': '01:02:03',
      'duration': 'P1DT2.000003S',
      'zero_duration': 'PT0S',
      'naive': '2026-01-01T12:30:00',
      'offset': '2026-01-01T12:30:00+05:30',
      'behind': '2026-01-01T12:30:00-05:30',
      'micros': '2026-01-01T12:30:00.123456Z',
    });
  });

  it('formats decimal and uuid as their string forms', () => {
    expect(actions.stateDelta).toMatchObject({
      price: '1.25',
      run: '12345678-1234-5678-1234-567812345678',
    });
  });

  it('flattens the dict subclasses and the set types', () => {
    expect(actions.stateDelta).toMatchObject({
      ordered: {a: 1, b: 2},
      counted: {a: [1]},
      tags: ['x'],
      frozen: ['y'],
      pair: [1, 2],
    });
  });

  it('keeps binary and out-of-range integers losslessly', () => {
    expect(actions.stateDelta).toMatchObject({
      raw: 'YWI=',
      huge: '1180591620717411303424',
    });
  });
});

describe('loadEventActions allowlist', () => {
  it('refuses a global that is not a type EventActions can hold', () => {
    expect(() => loadEventActions(fromBase64(EVIL_EXEC))).toThrow(
      'Refusing to load builtins.exec',
    );
  });

  it('names the opt-in in the refusal', () => {
    expect(() => loadEventActions(fromBase64(EVIL_EXEC))).toThrow(
      'allowUnsafeUnpickling',
    );
  });

  it('accepts the refused payload as inert data when opted in', () => {
    const actions = loadEventActions(fromBase64(EVIL_EXEC), {
      allowUnsafeUnpickling: true,
    });
    // The reader executes nothing either way, so the opt-in only turns the
    // allowlist off: the payload's callable becomes an empty record.
    expect(actions).toEqual({
      stateDelta: {},
      artifactDelta: {},
      requestedAuthConfigs: {},
      requestedToolConfirmations: {},
    });
    expect(process.env['ADK_MIGRATION_PICKLE_RCE']).toBeUndefined();
  });

  it('refuses a tzinfo that is not a fixed offset', () => {
    expect(() => loadEventActions(fromBase64(ZONEINFO_TZ))).toThrow(
      'Refusing to load builtins.getattr',
    );
  });

  it('rejects a payload whose root is not an actions object', () => {
    expect(() => loadEventActions(fromBase64(NOT_AN_OBJECT))).toThrow(
      'decoded to an array, not an object',
    );
  });

  it('rejects a payload whose root is a scalar', () => {
    expect(() => loadEventActions(payload(0x8c, 2, 'hi', STOP))).toThrow(
      'decoded to string, not an object',
    );
  });

  it('rejects a payload whose root is None', () => {
    expect(() => loadEventActions(payload(0x4e, STOP))).toThrow(
      'decoded to null, not an object',
    );
  });
});

describe('loadEventActions reconstructs unusual shapes', () => {
  /** Wraps opcodes producing one value as `{'state_delta': {'v': <value>}}`. */
  function inStateDelta(
    ...value: Array<number | string | Uint8Array>
  ): Uint8Array {
    return payload(
      0x7d,
      0x8c,
      11,
      'state_delta',
      0x7d,
      0x8c,
      1,
      'v',
      ...value,
      0x73,
      0x73,
      STOP,
    );
  }

  it('keeps the attributes of an object that is not a pydantic model', () => {
    // A NEWOBJ whose BUILD state is a plain dict rather than a `__dict__`.
    const actions = loadEventActions(
      inStateDelta(
        globalRef('google.genai.types', 'Part'),
        0x29,
        0x81,
        0x7d,
        0x8c,
        4,
        'text',
        0x8c,
        2,
        'hi',
        0x73,
        0x62,
      ),
    );
    expect(actions.stateDelta).toEqual({v: {text: 'hi'}});
  });

  it('treats a set built from a non-iterable argument as empty', () => {
    const actions = loadEventActions(
      inStateDelta(globalRef('builtins', 'set'), 0x4b, 1, 0x85, 0x52),
    );
    expect(actions.stateDelta).toEqual({v: []});
  });
});

describe('loadEventActions rejects a malformed value', () => {
  it('rejects a datetime whose packed argument is the wrong width', () => {
    expect(() =>
      loadEventActions(applied('datetime', 'datetime', 0x43, 3, 'abc', 0x85)),
    ).toThrow('A pickled datetime needs a 10-byte argument');
  });

  it('rejects a date whose packed argument is missing', () => {
    expect(() => loadEventActions(applied('datetime', 'date', 0x29))).toThrow(
      'A pickled date needs a 4-byte argument, got undefined',
    );
  });

  it('rejects a time whose packed argument is the wrong width', () => {
    expect(() =>
      loadEventActions(applied('datetime', 'time', 0x43, 1, 'a', 0x85)),
    ).toThrow('A pickled time needs a 6-byte argument');
  });

  it('rejects a timezone that does not hold a timedelta', () => {
    expect(() =>
      loadEventActions(applied('datetime', 'timezone', 0x4b, 1, 0x85)),
    ).toThrow('A pickled timezone does not hold a timedelta offset');
  });

  it('rejects a timedelta whose parts are not integers', () => {
    expect(() =>
      loadEventActions(
        applied(
          'datetime',
          'timezone',
          globalRef('datetime', 'timedelta'),
          0x8c,
          1,
          'x',
          0x4b,
          0,
          0x4b,
          0,
          0x87,
          0x52,
          0x85,
        ),
      ),
    ).toThrow('A pickled timedelta needs integer arguments, got string');
  });

  it('rejects a datetime whose tzinfo is not a timezone', () => {
    expect(() =>
      loadEventActions(
        applied(
          'datetime',
          'datetime',
          0x43,
          10,
          Uint8Array.from([7, 234, 1, 1, 12, 30, 0, 0, 0, 0]),
          0x4b,
          1,
          0x86,
        ),
      ),
    ).toThrow('carries a tzinfo that is not a fixed offset');
  });

  it('rejects a UUID whose int is not an integer', () => {
    // NEWOBJ, then BUILD with {'int': 'nope'}.
    expect(() =>
      loadEventActions(
        payload(
          globalRef('uuid', 'UUID'),
          0x29,
          0x81,
          0x7d,
          0x8c,
          3,
          'int',
          0x8c,
          4,
          'nope',
          0x73,
          0x62,
          STOP,
        ),
      ),
    ).toThrow('A pickled UUID holds string, not an integer');
  });

  it('rejects a value nested past the depth limit', () => {
    // 200 nested single-element lists.
    const depth = 200;
    const parts: Array<number | Uint8Array> = [];
    for (let i = 0; i < depth; i++) {
      parts.push(0x5d);
    }
    for (let i = 0; i < depth - 1; i++) {
      parts.push(0x61);
    }
    expect(() => loadEventActions(payload(...parts, STOP))).toThrow(
      'nests deeper than 64 levels',
    );
  });
});

describe('loadEventActions key handling', () => {
  it('renders a non-string dict key as its text form', () => {
    // {'state_delta': {1: 'one'}} as the decoded actions object.
    const actions = loadEventActions(
      payload(
        0x7d,
        0x8c,
        11,
        'state_delta',
        0x7d,
        0x4b,
        1,
        0x8c,
        3,
        'one',
        0x73,
        0x73,
        STOP,
      ),
    );
    expect(actions.stateDelta).toEqual({'1': 'one'});
  });
});
