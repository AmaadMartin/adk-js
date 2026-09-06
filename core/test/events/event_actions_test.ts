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
import {UiWidget} from '../../src/events/ui_widget.js';
import {ToolConfirmation} from '../../src/tools/tool_confirmation.js';
import {Logger, logger} from '../../src/utils/logger.js';

function createTestAuthConfig(credentialKey: string): AuthConfig {
  return {
    authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
    credentialKey,
  };
}

function createTestCompaction(): EventCompaction {
  return {
    startTimestamp: 1000,
    endTimestamp: 2000,
    compactedContent: {role: 'model', parts: [{text: 'the story so far'}]},
  };
}

/**
 * Builds an actions payload from untyped input, the way plain JavaScript or a
 * widened object reaches `createEventActions`. TypeScript's excess-property
 * check rejects a stray key in a literal, so a test for the runtime check has
 * to enter through the same door those callers use.
 */
function untypedActions(
  fields: Record<string, unknown>,
): Partial<EventActions> {
  const declared: Partial<EventActions> = {};
  return Object.assign(declared, fields);
}

/** One valid value per declared field, keyed so the compiler pins the set. */
const ONE_VALUE_PER_FIELD: Record<keyof EventActions, unknown> = {
  skipSummarization: true,
  stateDelta: {cartSize: 2},
  artifactDelta: {'report.pdf': 1},
  transferToAgent: 'billing_agent',
  escalate: true,
  requestedAuthConfigs: {'call-1': createTestAuthConfig('key-1')},
  requestedToolConfirmations: {
    'call-1': new ToolConfirmation({hint: 'ok?', confirmed: false}),
  },
  compaction: createTestCompaction(),
  agentState: {step: 3},
  endOfAgent: true,
  renderUiWidgets: [{id: 'call-1', provider: 'mcp', payload: {}}],
  transferReason: 'the user asked about an invoice',
  route: 'approved',
  setModelResponse: {answer: 42},
  rewindBeforeInvocationId: 'inv-1',
};

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
  ];

  it.each(nonDefaults)('returns false when %s', (_label, overrides) => {
    expect(isDefaultEventActions(createEventActions(overrides))).toBe(false);
  });

  it('returns false when compaction is set', () => {
    const actions = createEventActions({compaction: createTestCompaction()});
    expect(isDefaultEventActions(actions)).toBe(false);
  });

  it('returns false when setModelResponse is set', () => {
    const actions = createEventActions({setModelResponse: {answer: '42'}});

    expect(isDefaultEventActions(actions)).toBe(false);
  });

  it('returns true when setModelResponse is left undefined', () => {
    const actions = createEventActions({setModelResponse: undefined});
    expect(isDefaultEventActions(actions)).toBe(true);
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

  it('carries setModelResponse through the merge', () => {
    const result = mergeEventActions([
      createEventActions(),
      createEventActions({setModelResponse: {answer: 42}}),
    ]);
    expect(result.setModelResponse).toEqual({answer: 42});
  });

  it('uses last-writer-wins for setModelResponse', () => {
    const result = mergeEventActions([
      createEventActions({setModelResponse: {answer: 'first'}}),
      createEventActions({setModelResponse: {answer: 'second'}}),
    ]);
    expect(result.setModelResponse).toEqual({answer: 'second'});
  });

  it('keeps an earlier setModelResponse when a later source omits it', () => {
    const result = mergeEventActions([
      createEventActions({setModelResponse: {v: 1}}),
      createEventActions(),
    ]);
    expect(result.setModelResponse).toEqual({v: 1});
  });

  it('uses last-writer-wins for agentState', () => {
    const result = mergeEventActions([
      createEventActions({agentState: {input: 'first'}}),
      createEventActions({agentState: {input: 'second'}}),
    ]);
    expect(result.agentState).toEqual({input: 'second'});
  });

  it('uses last-writer-wins for endOfAgent', () => {
    const result = mergeEventActions([
      createEventActions({endOfAgent: false}),
      createEventActions({endOfAgent: true}),
    ]);
    expect(result.endOfAgent).toBe(true);
  });

  it('carries agentState and endOfAgent from a source that sets neither twice', () => {
    // A merge drops any field it does not name. These two were added to
    // EventActions after the merge was written, so a caller that replaces an
    // event's actions with a merge result lost its resume checkpoint and its
    // end-of-agent marker.
    const result = mergeEventActions([
      createEventActions({agentState: {input: 'x'}, endOfAgent: true}),
      createEventActions({stateDelta: {k: 'v'}}),
    ]);
    expect(result.agentState).toEqual({input: 'x'});
    expect(result.endOfAgent).toBe(true);
    expect(result.stateDelta).toEqual({k: 'v'});
  });

  it('leaves agentState and endOfAgent unset when no source sets them', () => {
    const result = mergeEventActions([
      createEventActions({stateDelta: {k: 1}}),
    ]);
    expect(result.agentState).toBeUndefined();
    expect(result.endOfAgent).toBeUndefined();
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

  it('carries setModelResponse across, last writer winning', () => {
    const result = mergeEventActions([
      createEventActions({setModelResponse: {answer: 1}}),
      createEventActions({setModelResponse: {answer: 2}}),
    ]);
    expect(result.setModelResponse).toEqual({answer: 2});
  });

  it('keeps an earlier setModelResponse when a later source omits it', () => {
    const result = mergeEventActions([
      createEventActions({setModelResponse: {answer: 1}}),
      createEventActions({escalate: true}),
    ]);
    expect(result.setModelResponse).toEqual({answer: 1});
  });

  it('ignores falsy sources', () => {
    const result = mergeEventActions([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      null as any,
      createEventActions({stateDelta: {x: 1}}),
    ]);
    expect(result.stateDelta).toEqual({x: 1});
  });

  it('leaves renderUiWidgets unset when no source sets it', () => {
    const result = mergeEventActions([
      createEventActions({stateDelta: {x: 1}}),
      createEventActions(),
    ]);
    expect(result.renderUiWidgets).toBeUndefined();
  });

  it('concatenates renderUiWidgets across sources in order', () => {
    const first: UiWidget = {id: 'a', provider: 'mcp', payload: {n: 1}};
    const second: UiWidget = {id: 'b', provider: 'mcp', payload: {n: 2}};

    const result = mergeEventActions([
      createEventActions({renderUiWidgets: [first]}),
      createEventActions(),
      createEventActions({renderUiWidgets: [second]}),
    ]);

    expect(result.renderUiWidgets).toEqual([first, second]);
  });

  it('does not mutate a source list while concatenating', () => {
    const source = createEventActions({
      renderUiWidgets: [{id: 'a', provider: 'mcp', payload: {}}],
    });

    mergeEventActions([
      source,
      createEventActions({
        renderUiWidgets: [{id: 'b', provider: 'mcp', payload: {}}],
      }),
    ]);

    expect(source.renderUiWidgets).toHaveLength(1);
  });

  it('uses last-writer-wins for rewindBeforeInvocationId', () => {
    const result = mergeEventActions([
      createEventActions({rewindBeforeInvocationId: 'inv-1'}),
      createEventActions({rewindBeforeInvocationId: 'inv-2'}),
    ]);
    expect(result.rewindBeforeInvocationId).toBe('inv-2');
  });

  it('keeps a set rewindBeforeInvocationId when a later source omits it', () => {
    const result = mergeEventActions([
      createEventActions({rewindBeforeInvocationId: 'inv-1'}),
      createEventActions({escalate: true}),
    ]);
    expect(result.rewindBeforeInvocationId).toBe('inv-1');
  });

  it('leaves rewindBeforeInvocationId unset when no source carries it', () => {
    const result = mergeEventActions([createEventActions({escalate: true})]);
    expect(result.rewindBeforeInvocationId).toBeUndefined();
  });

  it('uses last-writer-wins for compaction', () => {
    const first = createTestCompaction();
    const last = {...createTestCompaction(), endTimestamp: 3000};
    const result = mergeEventActions([
      createEventActions({compaction: first}),
      createEventActions({compaction: last}),
    ]);
    expect(result.compaction).toEqual(last);
  });

  it('keeps an earlier compaction when a later source leaves it unset', () => {
    const compaction = createTestCompaction();
    const result = mergeEventActions([
      createEventActions({compaction}),
      createEventActions({escalate: true}),
    ]);
    expect(result.compaction).toEqual(compaction);
  });
});

describe('isDefaultEventActions with UI widgets', () => {
  it('reports non-default when a widget is the only signal', () => {
    const actions = createEventActions({
      renderUiWidgets: [{id: 'a', provider: 'mcp', payload: {}}],
    });
    expect(isDefaultEventActions(actions)).toBe(false);
  });

  it('reports default when the widget list is empty', () => {
    const actions = createEventActions({renderUiWidgets: []});
    expect(isDefaultEventActions(actions)).toBe(true);
  });
});

describe('EventActions UI widgets', () => {
  const widget: UiWidget = {id: 'call-1', provider: 'mcp', payload: {}};

  it('concatenates the widgets of every source', () => {
    const other: UiWidget = {id: 'call-2', provider: 'mcp', payload: {}};

    const merged = mergeEventActions([
      {renderUiWidgets: [widget]},
      {stateDelta: {a: 1}},
      {renderUiWidgets: [other]},
    ]);

    expect(merged.renderUiWidgets).toEqual([widget, other]);
  });

  it('leaves renderUiWidgets unset when no source carries one', () => {
    const merged = mergeEventActions([{stateDelta: {a: 1}}]);

    expect(merged.renderUiWidgets).toBeUndefined();
  });

  it('treats an attached widget as a signal', () => {
    const actions = createEventActions({renderUiWidgets: [widget]});

    expect(isDefaultEventActions(actions)).toBe(false);
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

describe('createEventActions compaction', () => {
  it('leaves compaction unset by default', () => {
    expect(createEventActions().compaction).toBeUndefined();
  });

  it('keeps a supplied compaction verbatim', () => {
    const compaction = createTestCompaction();
    const actions = createEventActions({compaction});
    expect(actions.compaction).toEqual(compaction);
  });
});

describe('createEventActions unknown keys', () => {
  it('rejects a misspelled field and names it', () => {
    expect(() =>
      createEventActions(untypedActions({transferAgent: 'other_agent'})),
    ).toThrow(InputValidationError);
    expect(() =>
      createEventActions(untypedActions({transferAgent: 'other_agent'})),
    ).toThrow('EventActions received unknown key(s): transferAgent.');
  });

  it('reports every unknown key in one message', () => {
    expect(() =>
      createEventActions(untypedActions({transferAgent: 'a', endOfTurn: true})),
    ).toThrow(
      'EventActions received unknown key(s): transferAgent, endOfTurn.',
    );
  });

  it('rejects a snake_case field with the camelCase hint', () => {
    expect(() =>
      createEventActions(untypedActions({state_delta: {a: 1}})),
    ).toThrow(
      'EventActions received unknown key(s): state_delta. Fields are camelCase; see EventActions.',
    );
  });

  it('rejects an Object.prototype name carried as an own key', () => {
    expect(() => createEventActions(untypedActions({toString: 'x'}))).toThrow(
      'EventActions received unknown key(s): toString.',
    );
  });

  it.each(Object.keys(ONE_VALUE_PER_FIELD))('accepts the field %s', (field) => {
    const value = ONE_VALUE_PER_FIELD[field as keyof EventActions];
    expect(() =>
      createEventActions(untypedActions({[field]: value})),
    ).not.toThrow();
  });
});

describe('EventActions.renderUiWidgets', () => {
  function widget(id: string): UiWidget {
    return {id, provider: 'mcp', payload: {resource_uri: `ui://${id}`}};
  }

  it('is undefined on freshly created actions', () => {
    expect(createEventActions().renderUiWidgets).toBeUndefined();
  });

  it('makes the actions non-default once set', () => {
    const actions = createEventActions({renderUiWidgets: [widget('a')]});

    expect(isDefaultEventActions(actions)).toBe(false);
  });

  it('leaves the actions default when explicitly undefined', () => {
    const actions = createEventActions({renderUiWidgets: undefined});

    expect(isDefaultEventActions(actions)).toBe(true);
  });

  it('concatenates widget lists from two sources, in order', () => {
    const result = mergeEventActions([
      createEventActions({renderUiWidgets: [widget('a')]}),
      createEventActions({renderUiWidgets: [widget('b'), widget('c')]}),
    ]);

    expect(result.renderUiWidgets?.map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps an earlier list when a later source has no widgets', () => {
    const result = mergeEventActions([
      createEventActions({renderUiWidgets: [widget('a')]}),
      createEventActions({stateDelta: {x: 1}}),
    ]);

    expect(result.renderUiWidgets?.map((w) => w.id)).toEqual(['a']);
  });

  it('leaves renderUiWidgets undefined when no source has one', () => {
    const result = mergeEventActions([createEventActions({escalate: true})]);

    expect(result.renderUiWidgets).toBeUndefined();
  });

  it('does not mutate a source list', () => {
    const source = createEventActions({renderUiWidgets: [widget('a')]});

    mergeEventActions([
      source,
      createEventActions({renderUiWidgets: [widget('b')]}),
    ]);

    expect(source.renderUiWidgets?.map((w) => w.id)).toEqual(['a']);
  });

  it('appends source widgets onto a target list', () => {
    const target = createEventActions({renderUiWidgets: [widget('base')]});

    const result = mergeEventActions(
      [createEventActions({renderUiWidgets: [widget('added')]})],
      target,
    );

    expect(result.renderUiWidgets?.map((w) => w.id)).toEqual(['base', 'added']);
  });
});
