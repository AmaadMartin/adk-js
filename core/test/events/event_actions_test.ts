/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {MockInstance} from 'vitest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {AuthConfig} from '../../src/auth/auth_tool.js';
import {InputValidationError} from '../../src/errors/input_validation_error.js';
import {transformToCamelCaseEvent} from '../../src/events/event.js';
import {
  createEventActions,
  EventActions,
  EventCompaction,
  isDefaultEventActions,
  mergeEventActions,
  serializeEventActions,
} from '../../src/events/event_actions.js';
import {ToolConfirmation} from '../../src/tools/tool_confirmation.js';
import {Logger, logger} from '../../src/utils/logger.js';

function createTestAuthConfig(credentialKey: string): AuthConfig {
  return {
    authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
    credentialKey,
  };
}

function createTestCompaction(
  summary = 'the user booked a flight',
): EventCompaction {
  return {
    startTimestamp: 1000,
    endTimestamp: 2000,
    compactedContent: {role: 'model', parts: [{text: summary}]},
  };
}

describe('createEventActions', () => {
  it('creates an EventActions with empty dicts and no scalar fields', () => {
    const actions = createEventActions();
    expect(actions.stateDelta).toEqual({});
    expect(actions.artifactDelta).toEqual({});
    expect(actions.requestedAuthConfigs).toEqual({});
    expect(actions.requestedToolConfirmations).toEqual({});
    expect(actions.skipSummarization).toBeUndefined();
    expect(actions.transferToAgent).toBeUndefined();
    expect(actions.escalate).toBeUndefined();
  });

  it('applies a partial stateDelta override', () => {
    const actions = createEventActions({stateDelta: {key: 'value'}});
    expect(actions.stateDelta).toEqual({key: 'value'});
    expect(actions.artifactDelta).toEqual({});
  });

  it('applies scalar field overrides', () => {
    const actions = createEventActions({
      skipSummarization: true,
      transferToAgent: 'agent-b',
      escalate: true,
    });
    expect(actions.skipSummarization).toBe(true);
    expect(actions.transferToAgent).toBe('agent-b');
    expect(actions.escalate).toBe(true);
  });

  it('applies requestedAuthConfigs override', () => {
    const authConfig = createTestAuthConfig('key-1');
    const actions = createEventActions({
      requestedAuthConfigs: {'call-1': authConfig},
    });
    expect(actions.requestedAuthConfigs).toEqual({'call-1': authConfig});
  });

  it('applies requestedToolConfirmations override', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const confirmation = {toolName: 'my_tool'} as any;
    const actions = createEventActions({
      requestedToolConfirmations: {'call-1': confirmation},
    });
    expect(actions.requestedToolConfirmations).toEqual({
      'call-1': confirmation,
    });
  });
});

describe('isDefaultEventActions', () => {
  it('returns true for freshly created actions', () => {
    expect(isDefaultEventActions(createEventActions())).toBe(true);
  });

  const nonDefaults: Array<[string, Partial<EventActions>]> = [
    ['stateDelta has an entry', {stateDelta: {jobStarted: true}}],
    ['artifactDelta has an entry', {artifactDelta: {'report.pdf': 1}}],
    [
      'requestedAuthConfigs has an entry',
      {
        requestedAuthConfigs: {
          'call-1': {
            authScheme: {type: 'apiKey', name: 'X-API-Key', in: 'header'},
            credentialKey: 'call-1-key',
          },
        },
      },
    ],
    [
      'requestedToolConfirmations has an entry',
      {
        requestedToolConfirmations: {
          'call-1': new ToolConfirmation({hint: 'ok?', confirmed: false}),
        },
      },
    ],
    ['skipSummarization is true', {skipSummarization: true}],
    ['skipSummarization is explicitly false', {skipSummarization: false}],
    ['transferToAgent is set', {transferToAgent: 'other_agent'}],
    ['escalate is set', {escalate: true}],
    ['transferReason is set', {transferReason: 'user asked for billing'}],
    ['route is set', {route: 'approved'}],
    ['route is an empty array', {route: []}],
    ['setModelResponse is set', {setModelResponse: {ok: true}}],
    ['setModelResponse is explicitly null', {setModelResponse: null}],
    ['compaction is set', {compaction: createTestCompaction()}],
    ['rewindBeforeInvocationId is set', {rewindBeforeInvocationId: 'inv-1'}],
  ];

  it.each(nonDefaults)('returns false when %s', (_label, overrides) => {
    expect(isDefaultEventActions(createEventActions(overrides))).toBe(false);
  });
});

describe('mergeEventActions', () => {
  it('returns empty EventActions when sources array is empty', () => {
    const result = mergeEventActions([]);
    expect(result.stateDelta).toEqual({});
    expect(result.artifactDelta).toEqual({});
    expect(result.requestedAuthConfigs).toEqual({});
    expect(result.requestedToolConfirmations).toEqual({});
    expect(result.skipSummarization).toBeUndefined();
    expect(result.transferToAgent).toBeUndefined();
    expect(result.escalate).toBeUndefined();
  });

  it('merges stateDelta from multiple sources', () => {
    const result = mergeEventActions([
      {
        stateDelta: {a: 1},
        artifactDelta: {},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      },
      {
        stateDelta: {b: 2},
        artifactDelta: {},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      },
    ]);
    expect(result.stateDelta).toEqual({a: 1, b: 2});
  });

  it('merges artifactDelta from multiple sources', () => {
    const result = mergeEventActions([
      {
        stateDelta: {},
        artifactDelta: {'file.txt': 1},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      },
      {
        stateDelta: {},
        artifactDelta: {'other.txt': 2},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {},
      },
    ]);
    expect(result.artifactDelta).toEqual({'file.txt': 1, 'other.txt': 2});
  });

  it('merges requestedAuthConfigs from multiple sources', () => {
    const authConfig1 = createTestAuthConfig('key-1');
    const authConfig2 = createTestAuthConfig('key-2');
    const result = mergeEventActions([
      {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfigs: {'call-1': authConfig1},
        requestedToolConfirmations: {},
      },
      {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfigs: {'call-2': authConfig2},
        requestedToolConfirmations: {},
      },
    ]);
    expect(result.requestedAuthConfigs).toEqual({
      'call-1': authConfig1,
      'call-2': authConfig2,
    });
  });

  it('merges requestedToolConfirmations from multiple sources', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conf1 = {toolName: 'tool-a'} as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conf2 = {toolName: 'tool-b'} as any;
    const result = mergeEventActions([
      {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {'call-1': conf1},
      },
      {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfigs: {},
        requestedToolConfirmations: {'call-2': conf2},
      },
    ]);
    expect(result.requestedToolConfirmations).toEqual({
      'call-1': conf1,
      'call-2': conf2,
    });
  });

  it('uses last-writer-wins for skipSummarization', () => {
    const result = mergeEventActions([
      createEventActions({skipSummarization: false}),
      createEventActions({skipSummarization: true}),
    ]);
    expect(result.skipSummarization).toBe(true);
  });

  it('uses last-writer-wins for transferToAgent', () => {
    const result = mergeEventActions([
      createEventActions({transferToAgent: 'agent-a'}),
      createEventActions({transferToAgent: 'agent-b'}),
    ]);
    expect(result.transferToAgent).toBe('agent-b');
  });

  it('uses last-writer-wins for escalate', () => {
    const result = mergeEventActions([
      createEventActions({escalate: false}),
      createEventActions({escalate: true}),
    ]);
    expect(result.escalate).toBe(true);
  });

  it('applies target as the base before merging sources', () => {
    const target = createEventActions({stateDelta: {base: 'val'}});
    const result = mergeEventActions(
      [
        {
          stateDelta: {extra: 'new'},
          artifactDelta: {},
          requestedAuthConfigs: {},
          requestedToolConfirmations: {},
        },
      ],
      target,
    );
    expect(result.stateDelta).toEqual({base: 'val', extra: 'new'});
  });

  it('ignores falsy sources', () => {
    const result = mergeEventActions([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      null as any,
      createEventActions({stateDelta: {x: 1}}),
    ]);
    expect(result.stateDelta).toEqual({x: 1});
  });
});

describe('createEventActions requestedAuthConfigs validation', () => {
  it('accepts a well-formed config map', () => {
    const authConfig = createTestAuthConfig('call-1-key');
    const actions = createEventActions({
      requestedAuthConfigs: {'call-1': authConfig},
    });
    expect(actions.requestedAuthConfigs['call-1']).toBe(authConfig);
  });

  it('accepts an empty config map', () => {
    expect(() => createEventActions({requestedAuthConfigs: {}})).not.toThrow();
  });

  // A malformed entry reaches this code from storage, not from a literal, so
  // the rejection cases rebuild one the way a session service would: through
  // `transformToCamelCaseEvent`, which preserves the entries verbatim.
  function restoredAuthConfigs(
    entries: Record<string, unknown>,
  ): Partial<EventActions> {
    return transformToCamelCaseEvent({
      id: 'e1',
      invocation_id: 'inv1',
      actions: {requested_auth_configs: entries},
    }).actions;
  }

  it('rejects an entry missing authScheme', () => {
    expect(() =>
      createEventActions(restoredAuthConfigs({'call-1': {credentialKey: 'k'}})),
    ).toThrow(InputValidationError);
  });

  it('rejects an entry missing credentialKey', () => {
    expect(() =>
      createEventActions(
        restoredAuthConfigs({
          'call-1': {
            authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
          },
        }),
      ),
    ).toThrow(InputValidationError);
  });

  it('rejects a non-object entry and names the offending key', () => {
    expect(() =>
      createEventActions(restoredAuthConfigs({'call-2': 'auth_config'})),
    ).toThrow(/requestedAuthConfigs\['call-2'\]/);
  });

  it('rejects a null entry', () => {
    expect(() =>
      createEventActions(restoredAuthConfigs({'call-1': null})),
    ).toThrow(InputValidationError);
  });
});

describe('createEventActions parity fields', () => {
  it('leaves every parity field undefined by default', () => {
    const actions = createEventActions();
    expect(actions.transferReason).toBeUndefined();
    expect(actions.route).toBeUndefined();
    expect(actions.setModelResponse).toBeUndefined();
  });

  it('applies each parity field from the override', () => {
    const actions = createEventActions({
      transferReason: 'user asked for billing',
      route: ['a', 1, true],
      setModelResponse: {answer: 42},
    });
    expect(actions.transferReason).toBe('user asked for billing');
    expect(actions.route).toEqual(['a', 1, true]);
    expect(actions.setModelResponse).toEqual({answer: 42});
  });
});

describe('mergeEventActions parity fields', () => {
  it('keeps the last writer for each parity field', () => {
    const result = mergeEventActions([
      createEventActions({
        transferReason: 'first',
        route: 'a',
        setModelResponse: {v: 1},
      }),
      createEventActions({
        transferReason: 'second',
        route: 'b',
        setModelResponse: {v: 2},
      }),
    ]);
    expect(result.transferReason).toBe('second');
    expect(result.route).toBe('b');
    expect(result.setModelResponse).toEqual({v: 2});
  });

  it('does not clear an earlier value with a later unset field', () => {
    const result = mergeEventActions([
      createEventActions({
        transferReason: 'first',
        route: 'a',
        setModelResponse: {v: 1},
      }),
      createEventActions({escalate: true}),
    ]);
    expect(result.transferReason).toBe('first');
    expect(result.route).toBe('a');
    expect(result.setModelResponse).toEqual({v: 1});
  });

  it('copies setModelResponse by reference rather than merging it', () => {
    const response = {v: 1};
    const result = mergeEventActions([
      createEventActions({
        setModelResponse: response,
      }),
    ]);
    expect(result.setModelResponse).toBe(response);
  });
});

describe('compaction and rewindBeforeInvocationId', () => {
  it('leaves both fields undefined by default', () => {
    const actions = createEventActions();
    expect(actions.compaction).toBeUndefined();
    expect(actions.rewindBeforeInvocationId).toBeUndefined();
  });

  it('applies both fields from the override', () => {
    const compaction = createTestCompaction();
    const actions = createEventActions({
      compaction,
      rewindBeforeInvocationId: 'inv-1',
    });
    expect(actions.compaction).toEqual(compaction);
    expect(actions.rewindBeforeInvocationId).toBe('inv-1');
  });

  it('keeps the last writer for both fields', () => {
    const second = createTestCompaction('the user cancelled the flight');
    const result = mergeEventActions([
      createEventActions({
        compaction: createTestCompaction(),
        rewindBeforeInvocationId: 'inv-1',
      }),
      createEventActions({
        compaction: second,
        rewindBeforeInvocationId: 'inv-2',
      }),
    ]);
    expect(result.compaction).toBe(second);
    expect(result.rewindBeforeInvocationId).toBe('inv-2');
  });

  it('does not clear either field with a later unset source', () => {
    const compaction = createTestCompaction();
    const result = mergeEventActions([
      createEventActions({compaction, rewindBeforeInvocationId: 'inv-1'}),
      createEventActions({escalate: true}),
    ]);
    expect(result.compaction).toBe(compaction);
    expect(result.rewindBeforeInvocationId).toBe('inv-1');
  });
});

describe('serializeEventActions', () => {
  let warnSpy: MockInstance<Logger['warn']>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copies serializable fields through unchanged and stays quiet', () => {
    const actions = createEventActions({
      stateDelta: {a: 1, b: [1, 2]},
      agentState: {step: 'two'},
    });
    const serialized = serializeEventActions(actions);
    expect(serialized).not.toBe(actions);
    expect(serialized.stateDelta).toEqual({a: 1, b: [1, 2]});
    expect(serialized.agentState).toEqual({step: 'two'});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('replaces a function in stateDelta and keeps its siblings', () => {
    const actions = createEventActions({
      stateDelta: {cb: () => 1, ok: 2},
    });
    const serialized = serializeEventActions(actions);
    expect(serialized.stateDelta['ok']).toBe(2);
    expect(serialized.stateDelta['cb']).toEqual(
      expect.stringContaining('Function'),
    );
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });

  it('keeps a Date in stateDelta when the fallback runs', () => {
    const actions = createEventActions({
      stateDelta: {when: new Date('2024-01-02T03:04:05.000Z'), cb: () => 1},
    });
    expect(serializeEventActions(actions).stateDelta['when']).toBe(
      '2024-01-02T03:04:05.000Z',
    );
  });

  it('warns once naming stateDelta', () => {
    serializeEventActions(createEventActions({stateDelta: {cb: () => 1}}));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('`stateDelta`');
  });

  it('warns once for a replacement nested below the top level', () => {
    const serialized = serializeEventActions(
      createEventActions({stateDelta: {outer: {cb: () => 1}}}),
    );
    expect(serialized.stateDelta['outer']).toEqual({
      cb: expect.stringContaining('Function'),
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('replaces a function in agentState and keeps its siblings', () => {
    const actions = createEventActions({agentState: {cb: () => 1, n: 3}});
    const serialized = serializeEventActions(actions);
    expect(serialized.agentState?.['n']).toBe(3);
    expect(serialized.agentState?.['cb']).toEqual(
      expect.stringContaining('Function'),
    );
  });

  it('keeps a Date in agentState when the fallback runs', () => {
    const actions = createEventActions({
      agentState: {when: new Date('2024-01-02T03:04:05.000Z'), cb: () => 1},
    });
    expect(serializeEventActions(actions).agentState?.['when']).toBe(
      '2024-01-02T03:04:05.000Z',
    );
  });

  it('warns once naming agentState', () => {
    serializeEventActions(createEventActions({agentState: {cb: () => 1}}));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('`agentState`');
  });

  it('warns once per field when both need sanitizing', () => {
    serializeEventActions(
      createEventActions({
        stateDelta: {cb: () => 1},
        agentState: {cb: () => 2},
      }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('leaves an undefined agentState undefined', () => {
    const actions = createEventActions({stateDelta: {cb: () => 1}});
    expect(serializeEventActions(actions).agentState).toBeUndefined();
  });

  it('does not mutate the input actions', () => {
    const callback = () => 1;
    const actions = createEventActions({
      stateDelta: {cb: callback},
      agentState: {cb: callback},
    });
    serializeEventActions(actions);
    expect(actions.stateDelta['cb']).toBe(callback);
    expect(actions.agentState?.['cb']).toBe(callback);
  });

  it('does not throw for a bigint, a symbol or a cycle', () => {
    const cycle: Record<string, unknown> = {big: 1n, sym: Symbol('s')};
    cycle['self'] = cycle;
    const serialized = serializeEventActions(
      createEventActions({stateDelta: cycle}),
    );
    expect(serialized.stateDelta['big']).toBe('1');
    expect(serialized.stateDelta['sym']).toBe('Symbol(s)');
    expect(serialized.stateDelta['self']).toEqual({
      big: '1',
      sym: 'Symbol(s)',
      self: '[Circular]',
    });
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });
});
