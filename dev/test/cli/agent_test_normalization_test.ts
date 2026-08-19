/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/cli/test_agent_test_runner.py` from adk-python, and
 * adds the `normalizeIds` cases that suite does not cover.
 */

import {createEvent, Event} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  compareSortKeys,
  JsonObject,
  makeSortKey,
  normalizeEvents,
  normalizeIds,
  normalizeRebuiltEvents,
  remapNodePath,
  sortKeysDeep,
} from '../../src/cli/agent_test_normalization.js';

describe('normalizeEvents', () => {
  it('drops volatile fields and nulls from recorded JSON events', () => {
    const event: JsonObject = {
      id: 'e-1',
      timestamp: 1234.5,
      invocationId: 'i-1',
      usageMetadata: {totalTokenCount: 7},
      interactionId: 'server-token',
      turnComplete: true,
      author: 'agent',
      output: null,
    };

    // Everything that differs between two identical runs has to go, and
    // null-valued keys must not survive either.
    expect(normalizeEvents([event])).toEqual([{author: 'agent'}]);
  });

  it('agrees between Event objects and recorded JSON', () => {
    const event = createEvent({
      author: 'agent',
      invocationId: 'i-1',
      content: {role: 'model', parts: [{text: 'hello'}]},
      longRunningToolIds: ['b', 'a'],
      nodeInfo: {path: ''},
    });
    const recorded = JSON.parse(JSON.stringify(event)) as JsonObject;

    // This equality is the whole point of the function: a live run and the
    // fixture it is compared against must normalize to the same shape.
    expect(normalizeEvents([event])).toEqual(normalizeEvents([recorded]));
    expect(normalizeEvents([event])).toEqual([
      {
        author: 'agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
        nodeInfo: {path: ''},
        longRunningToolIds: ['a', 'b'],
      },
    ]);
  });

  it('leaves the input event untouched', () => {
    const event: JsonObject = {author: 'agent', id: 'e-1', timestamp: 1};

    normalizeEvents([event]);

    expect(event).toEqual({author: 'agent', id: 'e-1', timestamp: 1});
  });

  it('strips thought signatures from parts', () => {
    const event: JsonObject = {
      author: 'agent',
      content: {
        role: 'model',
        parts: [{text: 'hi', thoughtSignature: 'opaque-blob'}],
      },
    };

    const normalized = normalizeEvents([event]);

    expect(normalized[0]['content']).toEqual({
      role: 'model',
      parts: [{text: 'hi'}],
    });
  });

  it('drops the role only for human-in-the-loop requests', () => {
    const hitl: JsonObject = {
      author: 'agent',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'adk_request_confirmation'}}],
      },
    };
    const ordinary: JsonObject = {
      author: 'agent',
      content: {
        role: 'model',
        parts: [{functionCall: {name: 'roll_dice'}}],
      },
    };

    const normalized = normalizeEvents([hitl, ordinary]);

    // The role of a HITL request is not stable across runs; every other event
    // keeps it.
    expect(normalized[0]['content']).toEqual({
      parts: [{functionCall: {name: 'adk_request_confirmation'}}],
    });
    expect(normalized[1]['content']).toEqual({
      role: 'model',
      parts: [{functionCall: {name: 'roll_dice'}}],
    });
  });

  it('sorts longRunningToolIds and drops an empty list', () => {
    const unordered: JsonObject = {
      author: 'agent',
      longRunningToolIds: ['z', 'a', 'm'],
    };
    const empty: JsonObject = {author: 'agent', longRunningToolIds: []};

    const normalized = normalizeEvents([unordered, empty]);

    // The ids come from a set, so only the sorted form is reproducible.
    expect(normalized[0]['longRunningToolIds']).toEqual(['a', 'm', 'z']);
    expect(normalized[1]).toEqual({author: 'agent'});
  });

  it('prunes empty action groups', () => {
    const partlyEmpty: JsonObject = {
      author: 'agent',
      actions: {stateDelta: {}, artifactDelta: {'report.md': 1}},
    };
    const allEmpty: JsonObject = {
      author: 'agent',
      actions: {stateDelta: {}, artifactDelta: {}},
    };

    const normalized = normalizeEvents([partlyEmpty, allEmpty]);

    expect(normalized[0]['actions']).toEqual({artifactDelta: {'report.md': 1}});
    expect(normalized[1]).toEqual({author: 'agent'});
  });

  it('drops join-state keys from stateDelta', () => {
    const event: JsonObject = {
      author: 'agent',
      actions: {
        stateDelta: {answer: 42, fanout_join_state: {pending: 2}},
      },
    };

    const normalized = normalizeEvents([event]);

    // Join bookkeeping is an implementation detail of parallel execution.
    expect(normalized[0]['actions']).toEqual({stateDelta: {answer: 42}});
  });
});

describe('normalizeRebuiltEvents', () => {
  it('keeps the canonical ids and drops only what a rerun cannot reproduce', () => {
    const event: JsonObject = {
      id: 'e-1',
      invocationId: 'i-1',
      timestamp: 1234.5,
      usageMetadata: {totalTokenCount: 7},
      finishReason: 'STOP',
      author: 'agent',
      longRunningToolIds: [],
      content: {
        role: 'model',
        parts: [{text: 'hi', thoughtSignature: 'opaque-blob'}],
      },
      actions: {stateDelta: {}, artifactDelta: {}},
    };

    expect(normalizeRebuiltEvents([event])).toEqual([
      {
        id: 'e-1',
        invocationId: 'i-1',
        // The comparison pass drops finishReason; a rebuild records it.
        finishReason: 'STOP',
        author: 'agent',
        longRunningToolIds: [],
        content: {role: 'model', parts: [{text: 'hi'}]},
      },
    ]);
  });
});

describe('makeSortKey', () => {
  it('orders by author then node path', () => {
    const events: JsonObject[] = [
      {author: 'b', nodeInfo: {path: 'a'}},
      {author: 'a', nodeInfo: {path: 'z'}},
      {author: 'a', nodeInfo: {path: 'a'}},
      {author: 'a'},
    ];

    const ordered = [...events].sort(compareSortKeys);

    expect(ordered.map((event) => makeSortKey(event).slice(0, 2))).toEqual([
      ['a', ''],
      ['a', 'a'],
      ['a', 'z'],
      ['b', 'a'],
    ]);
  });

  it('treats a missing author and node path as empty strings', () => {
    expect(makeSortKey({})).toEqual(['', '', '{}']);
  });

  it('ignores key order but separates content', () => {
    const sameContentA: JsonObject = {author: 'a', first: 1, second: 2};
    const sameContentB: JsonObject = {author: 'a', second: 2, first: 1};
    const otherContent: JsonObject = {author: 'a', first: 1, second: 3};

    // Two events that only differ in insertion order must sort as one value,
    // otherwise fixture comparison depends on key ordering.
    expect(makeSortKey(sameContentA)).toEqual(makeSortKey(sameContentB));
    expect(compareSortKeys(sameContentA, sameContentB)).toBe(0);
    expect(compareSortKeys(sameContentA, otherContent)).toBeLessThan(0);
    expect(compareSortKeys(otherContent, sameContentA)).toBeGreaterThan(0);
  });
});

describe('sortKeysDeep', () => {
  it('sorts the keys of every nested object and keeps array order', () => {
    const sorted = sortKeysDeep({b: 1, a: [{d: 2, c: 3}], z: 'text'});

    expect(JSON.stringify(sorted)).toBe(
      '{"a":[{"c":3,"d":2}],"b":1,"z":"text"}',
    );
  });
});

describe('remapNodePath', () => {
  it('splits a node path on "." and remaps the mapped run ids', () => {
    // Regression pin: adk-python splits on "/", adk-js composes node paths
    // with ".". Splitting on "/" here is a silent no-op.
    const remapped = remapNodePath(
      'wf.child@abc.other@unmapped.plain',
      new Map([['abc', 'fc-1']]),
    );

    expect(remapped).toBe('wf.child@fc-1.other@unmapped.plain');
  });
});

describe('normalizeIds', () => {
  it('drops partial events and renumbers the rest', () => {
    const events = [
      createEvent({
        author: 'agent',
        content: {parts: [{text: 'partial'}]},
        partial: true,
      }),
      createEvent({author: 'agent', content: {parts: [{text: 'one'}]}}),
      createEvent({author: 'agent', content: {parts: [{text: 'two'}]}}),
    ];

    const normalized = normalizeIds(events);

    expect(normalized.map((event) => event.id)).toEqual(['e-1', 'e-2']);
    expect(normalized.map((event) => event.content?.parts?.[0].text)).toEqual([
      'one',
      'two',
    ]);
  });

  it('renumbers function calls and matches a response by call name', () => {
    const events = [
      callEvent('roll', 'random-1'),
      responseEvent('roll', 'random-1'),
      callEvent('roll', 'random-2'),
      responseEvent('roll', 'random-2'),
    ];

    normalizeIds(events);

    expect(callIds(events)).toEqual(['fc-1', undefined, 'fc-2', undefined]);
    expect(responseIds(events)).toEqual([undefined, 'fc-1', undefined, 'fc-2']);
  });

  it('falls back to the id map for a response with no matching call name', () => {
    const events = [
      callEvent('roll', 'random-1'),
      responseEvent('renamed_tool', 'random-1'),
    ];

    normalizeIds(events);

    expect(responseIds(events)).toEqual([undefined, 'fc-1']);
  });

  it('remaps an id echoed in longRunningToolIds', () => {
    const event = callEvent('roll', 'random-1');
    event.longRunningToolIds = ['random-1', 'unrelated'];

    normalizeIds([event]);

    expect(event.longRunningToolIds).toEqual(['fc-1', 'unrelated']);
  });

  it('remaps an id echoed in the call arguments', () => {
    const event = callEvent('roll', 'random-1');
    setArgs(event, {target: 'random-1', other: 'keep'});

    normalizeIds([event]);

    expect(event.content?.parts?.[0].functionCall?.args).toEqual({
      target: 'fc-1',
      other: 'keep',
    });
  });

  it('remaps an id echoed in isolationScope', () => {
    const call = callEvent('roll', 'random-1');
    const scoped = createEvent({author: 'agent', isolationScope: 'random-1'});

    normalizeIds([call, scoped]);

    expect(scoped.isolationScope).toBe('fc-1');
  });

  it('remaps an id echoed in a branch segment', () => {
    const call = callEvent('roll', 'random-1');
    const branched = createEvent({author: 'agent', branch: 'wf.node@random-1'});

    normalizeIds([call, branched]);

    expect(branched.branch).toBe('wf.node@fc-1');
  });

  it('remaps an id echoed in a task branch', () => {
    const call = callEvent('roll', 'random-1');
    const branched = createEvent({author: 'agent', branch: 'task:random-1'});

    normalizeIds([call, branched]);

    expect(branched.branch).toBe('task:fc-1');
  });

  it('remaps an id echoed in nodeInfo.path and nodeInfo.outputFor', () => {
    const call = callEvent('roll', 'random-1');
    const scoped = createEvent({
      author: 'agent',
      nodeInfo: {
        path: 'wf.node@random-1',
        outputFor: ['wf.node@random-1', 'wf'],
      },
    });

    normalizeIds([call, scoped]);

    expect(scoped.nodeInfo?.path).toBe('wf.node@fc-1');
    expect(scoped.nodeInfo?.outputFor).toEqual(['wf.node@fc-1', 'wf']);
  });

  it('remaps a nested id inside function call arguments', () => {
    const call = callEvent('roll', 'random-1');
    const confirmation = callEvent('adk_request_confirmation', 'random-2');
    setArgs(confirmation, {
      originalFunctionCall: {id: 'random-1', name: 'roll'},
      unrelated: ['random-1'],
    });

    normalizeIds([call, confirmation]);

    expect(confirmation.content?.parts?.[0].functionCall?.args).toEqual({
      originalFunctionCall: {id: 'fc-1', name: 'roll'},
      unrelated: ['random-1'],
    });
  });

  it('renumbers a call that carries no id, name or arguments', () => {
    const event = createEvent({
      author: 'agent',
      content: {
        role: 'model',
        parts: [{functionCall: {}}, {functionCall: {id: 'random-1'}}],
      },
    });

    normalizeIds([event]);

    expect(event.content?.parts?.map((part) => part.functionCall)).toEqual([
      {id: 'fc-1'},
      {id: 'fc-2'},
    ]);
  });

  it('leaves an unmapped isolationScope and response id alone', () => {
    const scoped = createEvent({author: 'agent', isolationScope: 'unmapped'});
    const orphan = responseEvent('never_called', 'unmapped-response');
    const unnamed = createEvent({
      author: 'agent',
      content: {role: 'user', parts: [{functionResponse: {id: 'unmapped-id'}}]},
    });

    normalizeIds([scoped, orphan, unnamed]);

    expect(scoped.isolationScope).toBe('unmapped');
    expect(responseIds([orphan, unnamed])).toEqual([
      'unmapped-response',
      'unmapped-id',
    ]);
  });

  it('remaps the keys of actions.requestedToolConfirmations', () => {
    const call = callEvent('roll', 'random-1');
    const pending = createEvent({
      author: 'agent',
      actions: {
        requestedToolConfirmations: {
          'random-1': {hint: 'confirm', confirmed: false},
          'unmapped': {hint: 'other', confirmed: false},
        },
      },
    });

    normalizeIds([call, pending]);

    expect(
      Object.keys(pending.actions.requestedToolConfirmations).sort(),
    ).toEqual(['fc-1', 'unmapped']);
  });
});

function callEvent(name: string, id: string): Event {
  return createEvent({
    author: 'agent',
    content: {role: 'model', parts: [{functionCall: {id, name, args: {}}}]},
  });
}

function responseEvent(name: string, id: string): Event {
  return createEvent({
    author: 'agent',
    content: {
      role: 'user',
      parts: [{functionResponse: {id, name, response: {result: 1}}}],
    },
  });
}

function setArgs(event: Event, args: Record<string, unknown>): void {
  const call = event.content?.parts?.[0].functionCall;
  if (!call) {
    expect.fail('the fixture event carries no function call');
  }
  call.args = args;
}

function callIds(events: readonly Event[]): Array<string | undefined> {
  return events.map((event) => event.content?.parts?.[0].functionCall?.id);
}

function responseIds(events: readonly Event[]): Array<string | undefined> {
  return events.map((event) => event.content?.parts?.[0].functionResponse?.id);
}
