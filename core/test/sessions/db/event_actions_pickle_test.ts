/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python's
 * `tests/unittests/sessions/test_dynamic_pickle_type.py`. Each test keeps the
 * reference test's name so the two suites stay comparable.
 */

import {describe, expect, it} from 'vitest';
import {createEventActions} from '../../../src/events/event_actions.js';
import {
  decodeEventActionsPickle,
  encodeEventActionsPickle,
} from '../../../src/sessions/db/event_actions_pickle.js';
import {
  loadPickle,
  PickleError,
  PickleErrorCode,
  PickleSecurityError,
} from '../../../src/utils/pickle_utils.js';
import {
  actionsBlob,
  DETONATING_PAYLOAD,
  EMPTY_ACTIONS_PAYLOAD,
  ENCODED_ACTIONS_GOLDEN,
  POPULATED_ACTIONS_PAYLOAD,
  SHARED_ACTIONS_VALUES_PAYLOAD,
  STDLIB_STATE_ACTIONS_PAYLOAD,
} from './pickled_actions_fixtures.js';

const SHORT_BINUNICODE = 0x8c;
const PROTO = 0x80;
const STACK_GLOBAL = 0x93;
const TUPLE1 = 0x85;
const REDUCE = 0x52;
const STOP = 0x2e;

/**
 * Handcrafts a payload that calls `module.name(argument)` when it loads.
 *
 * `pickle.dumps` cannot express a global the writing process does not hold,
 * and it resolves `os.system` to its `posix` alias, so the payloads an
 * attacker would actually write have to be assembled by hand. Mirrors
 * `_call_global_payload` in the reference test.
 */
function callGlobalPayload(
  module: string,
  name: string,
  argument: string,
): Uint8Array {
  const shortUnicode = (value: string) => {
    const encoded = Array.from(Buffer.from(value, 'utf-8'));
    return [SHORT_BINUNICODE, encoded.length, ...encoded];
  };
  return Uint8Array.from([
    PROTO,
    4,
    ...shortUnicode(module),
    ...shortUnicode(name),
    STACK_GLOBAL,
    ...shortUnicode(argument),
    TUPLE1,
    REDUCE,
    STOP,
  ]);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    expect.fail(`Expected a plain object, got ${String(value)}.`);
  }
  return value as Record<string, unknown>;
}

describe('decodeEventActionsPickle', () => {
  it('test_reading_event_still_loads_stored_actions', () => {
    const actions = decodeEventActionsPickle(
      actionsBlob(POPULATED_ACTIONS_PAYLOAD),
    );

    expect(actions.stateDelta['user:name']).toBe('Ada');
    expect(actions.stateDelta['count']).toBe(3);
    expect(actions.stateDelta['nested']).toEqual({a: [1, 2]});
    expect(actions.artifactDelta).toEqual({'report.txt': 2});
    expect(actions.transferToAgent).toBe('analyst');
    expect(actions.escalate).toBe(true);
    expect(actions.skipSummarization).toBe(true);
    expect(actions.agentState).toEqual({step: 'done'});
    expect(actions.endOfAgent).toBe(true);
  });

  it('decodes a nested pydantic model into its fields', () => {
    const actions = decodeEventActionsPickle(
      actionsBlob(POPULATED_ACTIONS_PAYLOAD),
    );

    const authConfig = asRecord(actions.requestedAuthConfigs['call-1']);
    // `requested_auth_configs` is a preserved subtree in both schemas, so its
    // field names stay in the snake_case adk-python wrote.
    expect(authConfig['credential_key']).toBe('adk_openid_key');
    expect(asRecord(authConfig['auth_scheme'])['token_endpoint']).toBe(
      'https://example.com/token',
    );
    const credential = asRecord(authConfig['raw_auth_credential']);
    expect(credential['auth_type']).toBe('serviceAccount');
    expect(asRecord(asRecord(credential['http'])['credentials'])).toEqual({
      token: 'token',
    });
  });

  it('decodes a requested tool confirmation', () => {
    const actions = decodeEventActionsPickle(
      actionsBlob(POPULATED_ACTIONS_PAYLOAD),
    );

    expect(actions.requestedToolConfirmations['call-1']).toEqual({
      hint: 'approve?',
      confirmed: true,
      payload: {key: 'value'},
    });
  });

  it('carries a field only adk-python declares', () => {
    const actions = decodeEventActionsPickle(
      actionsBlob(POPULATED_ACTIONS_PAYLOAD),
    );

    expect(asRecord(actions)['rewindBeforeInvocationId']).toBe('invocation-1');
  });

  it('gives every dictionary field its default when the blob is empty', () => {
    const actions = decodeEventActionsPickle(
      actionsBlob(EMPTY_ACTIONS_PAYLOAD),
    );

    expect(actions.stateDelta).toEqual({});
    expect(actions.artifactDelta).toEqual({});
    expect(actions.requestedAuthConfigs).toEqual({});
    expect(actions.requestedToolConfirmations).toEqual({});
    expect(actions.transferToAgent).toBeNull();
  });

  it('test_plain_stdlib_state_values_still_load', () => {
    const state = decodeEventActionsPickle(
      actionsBlob(STDLIB_STATE_ACTIONS_PAYLOAD),
    ).stateDelta;

    expect(state['ordered_dict']).toEqual({a: 1, b: 2});
    expect(state['default_dict']).toEqual({a: [1]});
    expect(state['date']).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(state['time']).toBe('12:30:00.000000');
    expect(state['time_tz']).toBe('12:30:00.000000');
    expect(state['datetime_naive']).toEqual(
      new Date('2026-01-02T03:04:05.123Z'),
    );
    expect(state['datetime_tz']).toEqual(new Date('2026-01-01T22:04:05.123Z'));
    expect(state['timedelta']).toBe(1000);
    expect(state['uuid']).toBe('12345678-1234-5678-1234-567812345678');
    expect(state['decimal']).toBe('1.5');
    expect(state['pure_path']).toBe('/data/x.txt');
    expect(state['windows_path']).toBe('C:/a/b.txt');
    expect(state['complex']).toEqual({real: 1, imag: 2});
    expect(state['bytes']).toEqual(Uint8Array.from(Buffer.from('value')));
    expect(state['tuple']).toEqual([1, 2]);
    expect(state['set']).toEqual([1, 2]);
  });

  it('admits a google.genai.types enum, which the module rule covers', () => {
    const state = decodeEventActionsPickle(
      actionsBlob(POPULATED_ACTIONS_PAYLOAD),
    ).stateDelta;

    expect(state['outcome']).toBe('OUTCOME_OK');
  });

  it('gives both references to one model the same fields', () => {
    const actions = decodeEventActionsPickle(
      actionsBlob(SHARED_ACTIONS_VALUES_PAYLOAD),
    );

    // adk-python writes one `ToolConfirmation` and references the memo for the
    // second call id, so the second must not come back empty.
    expect(actions.requestedToolConfirmations['call-2']).toEqual({
      hint: 'approve?',
      confirmed: true,
      payload: null,
    });
    expect(actions.requestedToolConfirmations['call-1']).toEqual(
      actions.requestedToolConfirmations['call-2'],
    );
  });

  it('gives both references to one uuid the same value', () => {
    const state = decodeEventActionsPickle(
      actionsBlob(SHARED_ACTIONS_VALUES_PAYLOAD),
    ).stateDelta;

    expect(state['first']).toBe('12345678-1234-5678-1234-567812345678');
    expect(state['second']).toBe(state['first']);
  });

  it('test_process_result_value_rejects_disallowed_global', () => {
    expect(() =>
      decodeEventActionsPickle(actionsBlob(DETONATING_PAYLOAD)),
    ).toThrow(PickleSecurityError);
  });

  it('test_blocked_global_error_is_diagnosable', () => {
    let caught: unknown;
    try {
      decodeEventActionsPickle(actionsBlob(DETONATING_PAYLOAD));
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PickleSecurityError);
    const message = (caught as Error).message;
    expect(message).toContain('_detonate');
    expect(message).toContain('__main__');
    expect(message).toContain('not a type that `EventActions` can hold');
  });

  it.each([
    ['os_system', 'os', 'system'],
    ['builtins_eval', 'builtins', 'eval'],
    ['via_pathlib', 'pathlib', 'os.system'],
    ['via_uuid', 'uuid', 'os.system'],
    ['via_ordered', 'collections', 'OrderedDict.fromkeys'],
    ['via_genai_module_prefix', 'google.genai.types.evil', 'System'],
    ['via_adk_module', 'google.adk.tools.bash_tool', 'run'],
  ])(
    'test_dangerous_globals_stay_refused (%s)',
    (_id, moduleName, attributeName) => {
      expect(() =>
        decodeEventActionsPickle(
          callGlobalPayload(moduleName, attributeName, 'echo unreached'),
        ),
      ).toThrowError(
        expect.objectContaining({code: PickleErrorCode.REFUSED_GLOBAL}),
      );
    },
  );

  it('test_defaultdict_factory_must_itself_be_allowlisted', () => {
    const shortUnicode = (value: string) => {
      const encoded = Array.from(Buffer.from(value, 'utf-8'));
      return [SHORT_BINUNICODE, encoded.length, ...encoded];
    };
    const payload = Uint8Array.from([
      PROTO,
      4,
      ...shortUnicode('collections'),
      ...shortUnicode('defaultdict'),
      STACK_GLOBAL,
      ...shortUnicode('posix'),
      ...shortUnicode('system'),
      STACK_GLOBAL,
      TUPLE1,
      REDUCE,
      STOP,
    ]);

    expect(() => decodeEventActionsPickle(payload)).toThrow(
      PickleSecurityError,
    );
  });

  it('test_call_global_payload_would_execute_unrestricted', () => {
    // The reference proves the handcrafted payload really reaches a callable by
    // loading it unrestricted. Nothing here can run Python, so the equivalent
    // assertion is that the payload does name a global and reduce through it: a
    // resolver that allowed the global would build a value from its argument.
    const seen: string[] = [];

    const decoded = loadPickle(
      callGlobalPayload('builtins', 'eval', '1 + 1'),
      (pickleGlobal) => {
        seen.push(`${pickleGlobal.module}.${pickleGlobal.name}`);
        return {create: (args) => args[0]};
      },
    );

    expect(seen).toEqual(['builtins.eval']);
    expect(decoded).toBe('1 + 1');
  });
});

describe('encodeEventActionsPickle', () => {
  it('round-trips actions through the reader', () => {
    const actions = createEventActions({
      skipSummarization: true,
      stateDelta: {'user:name': 'Ada', count: 3, nested: {a: [1, 2]}},
      artifactDelta: {'report.txt': 2},
      transferToAgent: 'analyst',
      escalate: true,
      agentState: {step: 'done'},
      endOfAgent: true,
    });

    const decoded = decodeEventActionsPickle(encodeEventActionsPickle(actions));

    expect(decoded).toEqual(actions);
  });

  it('round-trips default actions', () => {
    const actions = createEventActions();

    expect(decodeEventActionsPickle(encodeEventActionsPickle(actions))).toEqual(
      actions,
    );
  });

  it('round-trips a requested auth config and tool confirmation', () => {
    const actions = createEventActions({
      requestedAuthConfigs: {
        'call-1': {
          authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
          credentialKey: 'adk_api_key',
        },
      },
      requestedToolConfirmations: {
        'call-1': {hint: 'approve?', confirmed: true, payload: {key: 'value'}},
      },
    });

    const decoded = decodeEventActionsPickle(encodeEventActionsPickle(actions));

    expect(decoded.requestedAuthConfigs).toEqual(actions.requestedAuthConfigs);
    expect(decoded.requestedToolConfirmations).toEqual(
      actions.requestedToolConfirmations,
    );
  });

  it('emits the bytes CPython loads as an EventActions', () => {
    const actions = createEventActions({
      skipSummarization: true,
      stateDelta: {'user:name': 'Ada', count: 3},
      artifactDelta: {'report.txt': 2},
      transferToAgent: 'analyst',
      escalate: true,
    });

    const written = Buffer.from(encodeEventActionsPickle(actions));

    expect(written.toString('base64')).toBe(ENCODED_ACTIONS_GOLDEN);
  });

  it('drops an undefined field rather than writing it', () => {
    const actions = createEventActions({
      stateDelta: {present: 'yes', absent: undefined},
    });

    const decoded = decodeEventActionsPickle(encodeEventActionsPickle(actions));

    expect(decoded.stateDelta).toEqual({present: 'yes'});
  });

  it('writes a Date in a state delta as its ISO string', () => {
    const actions = createEventActions({
      stateDelta: {when: new Date('2026-01-02T03:04:05.000Z')},
    });

    const decoded = decodeEventActionsPickle(encodeEventActionsPickle(actions));

    expect(decoded.stateDelta['when']).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('decodeEventActionsPickle defaults', () => {
  const shortUnicode = (value: string) => {
    const encoded = Array.from(Buffer.from(value, 'utf-8'));
    return [SHORT_BINUNICODE, encoded.length, ...encoded];
  };

  it('defaults a dictionary field a corrupt blob left null', () => {
    // pydantic annotates `state_delta` as a plain dict, so adk-python never
    // writes None there. A caller reading the keys still must not crash.
    const payload = Uint8Array.from([
      PROTO,
      4,
      ...shortUnicode('google.adk.events.event_actions'),
      ...shortUnicode('EventActions'),
      STACK_GLOBAL,
      0x29,
      0x81,
      0x7d,
      ...shortUnicode('state_delta'),
      0x4e,
      0x73,
      0x62,
      STOP,
    ]);

    expect(decodeEventActionsPickle(payload).stateDelta).toEqual({});
  });

  it('keeps a __proto__ key in a state delta as ordinary data', () => {
    const payload = Uint8Array.from([
      PROTO,
      4,
      ...shortUnicode('google.adk.events.event_actions'),
      ...shortUnicode('EventActions'),
      STACK_GLOBAL,
      0x29,
      0x81,
      0x7d,
      ...shortUnicode('state_delta'),
      0x7d,
      ...shortUnicode('__proto__'),
      ...shortUnicode('kept'),
      0x73,
      0x73,
      0x62,
      STOP,
    ]);

    const state = decodeEventActionsPickle(payload).stateDelta;

    expect(Object.keys(state)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(state, '__proto__')?.value).toBe(
      'kept',
    );
  });
});

describe('decodeEventActionsPickle failure paths', () => {
  it('reports a blob that does not hold an actions object', () => {
    const payload = Uint8Array.from([PROTO, 4, 0x4b, 0x01, STOP]);

    expect(() => decodeEventActionsPickle(payload)).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });

  it('reports a model whose BUILD state is not a dictionary', () => {
    const shortUnicode = (value: string) => {
      const encoded = Array.from(Buffer.from(value, 'utf-8'));
      return [SHORT_BINUNICODE, encoded.length, ...encoded];
    };
    const payload = Uint8Array.from([
      PROTO,
      4,
      ...shortUnicode('google.adk.events.event_actions'),
      ...shortUnicode('EventActions'),
      STACK_GLOBAL,
      0x29,
      0x81,
      0x4e,
      0x62,
      STOP,
    ]);

    expect(() => decodeEventActionsPickle(payload)).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });

  it('reads a model state that carries the fields directly', () => {
    const shortUnicode = (value: string) => {
      const encoded = Array.from(Buffer.from(value, 'utf-8'));
      return [SHORT_BINUNICODE, encoded.length, ...encoded];
    };
    // A `BUILD` state with no `__dict__` is Python's default attribute
    // update, which an older pydantic wrote.
    const payload = Uint8Array.from([
      PROTO,
      4,
      ...shortUnicode('google.adk.events.event_actions'),
      ...shortUnicode('EventActions'),
      STACK_GLOBAL,
      0x29,
      0x81,
      0x7d,
      ...shortUnicode('transfer_to_agent'),
      ...shortUnicode('analyst'),
      0x73,
      0x62,
      STOP,
    ]);

    expect(decodeEventActionsPickle(payload).transferToAgent).toBe('analyst');
  });

  it('reports a model whose fields are not a dictionary', () => {
    const shortUnicode = (value: string) => {
      const encoded = Array.from(Buffer.from(value, 'utf-8'));
      return [SHORT_BINUNICODE, encoded.length, ...encoded];
    };
    const payload = Uint8Array.from([
      PROTO,
      4,
      ...shortUnicode('google.adk.events.event_actions'),
      ...shortUnicode('EventActions'),
      STACK_GLOBAL,
      0x29,
      0x81,
      0x7d,
      ...shortUnicode('__dict__'),
      ...shortUnicode('not a dictionary'),
      0x73,
      0x62,
      STOP,
    ]);

    expect(() => decodeEventActionsPickle(payload)).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });

  it('reports a BUILD onto a model the payload built as a list', () => {
    const shortUnicode = (value: string) => {
      const encoded = Array.from(Buffer.from(value, 'utf-8'));
      return [SHORT_BINUNICODE, encoded.length, ...encoded];
    };
    // A single REDUCE argument builds an enum member, so a payload can hand
    // the factory a list and then try to apply a state to it.
    const payload = Uint8Array.from([
      PROTO,
      4,
      ...shortUnicode('google.adk.events.event_actions'),
      ...shortUnicode('EventActions'),
      STACK_GLOBAL,
      0x5d,
      0x85,
      REDUCE,
      0x7d,
      0x62,
      STOP,
    ]);

    expect(() => decodeEventActionsPickle(payload)).toThrowError(
      expect.objectContaining({code: PickleErrorCode.UNSUPPORTED_TARGET}),
    );
  });

  it('does not swallow a decode failure into empty actions', () => {
    expect(() => decodeEventActionsPickle(Uint8Array.from([PROTO, 4]))).toThrow(
      PickleError,
    );
  });
});
