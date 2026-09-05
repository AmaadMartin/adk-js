/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// The `test_normalize_events_*` and `test_make_sort_key_*` cases are ported
// from google/adk-python tests/unittests/cli/test_agent_test_runner.py (main).

import {
  createEvent,
  Event,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  ToolConfirmation,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  EXCLUDED_EVENT_FIELDS,
  makeSortKey,
  normalizeEvents,
  normalizeIds,
  normalizeRebuiltEvents,
  sortBySortKey,
} from '../../src/cli/agent_test_normalization.js';

describe('normalizeEvents', () => {
  it('test_normalize_events_drops_volatile_fields_and_nulls_from_json_events', () => {
    const event = {
      id: 'e-1',
      timestamp: 1234.5,
      invocationId: 'i-1',
      invocation_id: 'i-1',
      usageMetadata: {totalTokenCount: 7},
      interactionId: 'server-token',
      turnComplete: true,
      author: 'agent',
      output: null,
    };

    // Everything that differs between two identical runs has to go, in either
    // naming convention, and null-valued keys must not survive either.
    expect(normalizeEvents([event])).toEqual([{author: 'agent'}]);
  });

  it('test_normalize_events_agrees_between_event_objects_and_recorded_json', () => {
    const event = createEvent({
      author: 'agent',
      invocationId: 'i-1',
      content: {role: 'model', parts: [{text: 'hello'}]},
      longRunningToolIds: ['b', 'a'],
    });
    const recorded = JSON.parse(JSON.stringify(event)) as Record<
      string,
      unknown
    >;

    // This equality is the whole point of the function: a live run and the
    // fixture it is compared against must normalize to the same shape.
    expect(normalizeEvents([event])).toEqual(normalizeEvents([recorded]));
    // An adk-js event carries no `nodeInfo` until a workflow node emits one,
    // where a fresh adk-python event dumps `nodeInfo: {path: ''}`.
    expect(normalizeEvents([event])).toEqual([
      {
        author: 'agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
        longRunningToolIds: ['a', 'b'],
      },
    ]);
  });

  it('test_normalize_events_strips_thought_signatures_from_parts', () => {
    const event = {
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

  it('test_normalize_events_drops_role_only_for_human_in_the_loop_requests', () => {
    const hitl = {
      author: 'agent',
      content: {
        role: 'model',
        parts: [
          {functionCall: {name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME}},
        ],
      },
    };
    const ordinary = {
      author: 'agent',
      content: {role: 'model', parts: [{functionCall: {name: 'roll_dice'}}]},
    };

    const normalized = normalizeEvents([hitl, ordinary]);

    // The role of a request is not stable across runs; every other event
    // keeps it.
    expect(normalized[0]['content']).not.toHaveProperty('role');
    expect(normalized[1]['content']).toHaveProperty('role', 'model');
  });

  it('test_normalize_events_sorts_long_running_tool_ids_and_drops_empty_lists', () => {
    const unordered = {author: 'agent', longRunningToolIds: ['z', 'a', 'm']};
    const empty = {author: 'agent', longRunningToolIds: []};

    const normalized = normalizeEvents([unordered, empty]);

    // The ids come from a set, so only the sorted form is reproducible.
    expect(normalized[0]['longRunningToolIds']).toEqual(['a', 'm', 'z']);
    expect(normalized[1]).not.toHaveProperty('longRunningToolIds');
  });

  it('test_normalize_events_prunes_empty_action_groups', () => {
    const partlyEmpty = {
      author: 'agent',
      actions: {stateDelta: {}, artifactDelta: {'report.md': 1}},
    };
    const allEmpty = {
      author: 'agent',
      actions: {stateDelta: {}, artifactDelta: {}},
    };

    const normalized = normalizeEvents([partlyEmpty, allEmpty]);

    expect(normalized[0]['actions']).toEqual({
      artifactDelta: {'report.md': 1},
    });
    expect(normalized[1]).not.toHaveProperty('actions');
  });

  it('test_normalize_events_drops_join_state_keys_from_state_delta', () => {
    const event = {
      author: 'agent',
      actions: {
        stateDelta: {answer: 42, fanout_join_state: {pending: 2}},
      },
    };

    const normalized = normalizeEvents([event]);

    // Join bookkeeping is an implementation detail of parallel execution.
    expect(normalized[0]['actions']).toEqual({stateDelta: {answer: 42}});
  });

  it('leaves the recorded event it was given untouched', () => {
    const event = {
      author: 'agent',
      timestamp: 1,
      content: {role: 'model', parts: [{text: 'hi', thoughtSignature: 'x'}]},
    };

    normalizeEvents([event]);

    expect(event.timestamp).toBe(1);
    expect(event.content.parts[0].thoughtSignature).toBe('x');
  });
});

describe('EXCLUDED_EVENT_FIELDS', () => {
  it('lists every field adk-python excludes from a comparison', () => {
    expect([...EXCLUDED_EVENT_FIELDS].sort()).toEqual([
      'avgLogprobs',
      'cacheMetadata',
      'citationMetadata',
      'finishReason',
      'id',
      'interactionId',
      'invocationId',
      'logprobsResult',
      'modelVersion',
      'timestamp',
      'turnComplete',
      'usageMetadata',
    ]);
  });
});

describe('makeSortKey', () => {
  it('test_make_sort_key_orders_by_author_then_node_path', () => {
    const events = [
      {author: 'b', nodeInfo: {path: 'a'}},
      {author: 'a', nodeInfo: {path: 'z'}},
      {author: 'a', nodeInfo: {path: 'a'}},
      {author: 'a'},
    ];

    const ordered = sortBySortKey(events);

    expect(
      ordered.map((event) => [
        event['author'],
        (event['nodeInfo'] as {path?: string} | undefined)?.path ?? '',
      ]),
    ).toEqual([
      ['a', ''],
      ['a', 'a'],
      ['a', 'z'],
      ['b', 'a'],
    ]);
  });

  it('test_make_sort_key_ignores_dict_key_order_but_separates_content', () => {
    const sameContentA = {author: 'a', first: 1, second: 2};
    const sameContentB = {author: 'a', second: 2, first: 1};
    const otherContent = {author: 'a', first: 1, second: 3};

    // Two events that only differ in insertion order must sort as one value,
    // otherwise fixture comparison depends on key ordering.
    expect(makeSortKey(sameContentA)).toBe(makeSortKey(sameContentB));
    expect(makeSortKey(sameContentA) < makeSortKey(otherContent)).toBe(true);
  });

  it('orders a shorter author before the longer author it prefixes', () => {
    const ordered = sortBySortKey([{author: 'ab'}, {author: 'a'}]);

    expect(ordered.map((event) => event['author'])).toEqual(['a', 'ab']);
  });

  it('keeps two events with the same key in their original order', () => {
    const first = {author: 'a', seq: 1};
    const second = {author: 'a', seq: 1};

    expect(sortBySortKey([first, second])).toEqual([first, second]);
  });

  it('reads a missing author and a non-string node path as empty', () => {
    expect(makeSortKey({nodeInfo: {path: 42}}).startsWith('\u0000\u0000')).toBe(
      true,
    );
  });
});

describe('normalizeIds', () => {
  it('drops partial events and renumbers the rest', () => {
    const events = [
      createEvent({author: 'agent', id: 'x1', partial: true}),
      createEvent({author: 'agent', id: 'x2'}),
      createEvent({author: 'agent', id: 'x3'}),
    ];

    const normalized = normalizeIds(events);

    expect(normalized.map((event) => event.id)).toEqual(['e-1', 'e-2']);
  });

  it('renumbers function calls and follows the id into the ids it is echoed in', () => {
    const call = createEvent({
      author: 'agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'random-1',
              name: 'roll',
              args: {echo: 'random-1'},
            },
          },
        ],
      },
      longRunningToolIds: ['random-1', 'other'],
      branch: 'task:random-1',
      isolationScope: 'random-1',
      nodeInfo: {path: 'root/roll@random-1', outputFor: ['root/roll@random-1']},
    });

    const [normalized] = normalizeIds([call]);

    expect(normalized.content?.parts?.[0]?.functionCall).toEqual({
      id: 'fc-1',
      name: 'roll',
      args: {echo: 'fc-1'},
    });
    expect(normalized.longRunningToolIds).toEqual(['fc-1', 'other']);
    expect(normalized.branch).toBe('task:fc-1');
    expect(normalized.isolationScope).toBe('fc-1');
    expect(normalized.nodeInfo).toEqual({
      path: 'root/roll@fc-1',
      outputFor: ['root/roll@fc-1'],
    });
  });

  it('remaps a branch that names the call as a path segment', () => {
    const events = [
      createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'random-1', name: 'roll'}}],
        },
      }),
      createEvent({author: 'agent', branch: 'parent.roll@random-1'}),
    ];

    const normalized = normalizeIds(events);

    expect(normalized[1].branch).toBe('parent.roll@fc-1');
  });

  it('leaves a branch and a node path alone when no segment names a call', () => {
    const event = createEvent({
      author: 'agent',
      branch: 'parent.child',
      isolationScope: 'unmapped',
      nodeInfo: {path: 'root/child'},
    });

    const [normalized] = normalizeIds([event]);

    expect(normalized.branch).toBe('parent.child');
    expect(normalized.isolationScope).toBe('unmapped');
    expect(normalized.nodeInfo?.path).toBe('root/child');
  });

  it('pairs a function response with the call of the same name', () => {
    const events = [
      createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'random-1', name: 'roll'}}],
        },
      }),
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {functionResponse: {id: 'unrelated', name: 'roll', response: {}}},
          ],
        },
      }),
    ];

    const normalized = normalizeIds(events);

    expect(normalized[1].content?.parts?.[0]?.functionResponse?.id).toBe(
      'fc-1',
    );
  });

  it('falls back to the id when no call carries the response name', () => {
    const events = [
      createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'random-1', name: 'roll'}}],
        },
      }),
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {functionResponse: {id: 'random-1', name: 'other', response: {}}},
          ],
        },
      }),
    ];

    const normalized = normalizeIds(events);

    expect(normalized[1].content?.parts?.[0]?.functionResponse?.id).toBe(
      'fc-1',
    );
  });

  it('remaps the call id nested in a confirmation request', () => {
    const events = [
      createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'random-1', name: 'roll'}}],
        },
      }),
      createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'random-2',
                name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
                args: {
                  originalFunctionCall: {id: 'random-1', name: 'roll'},
                  hints: [{id: 'random-1'}],
                },
              },
            },
          ],
        },
        actions: {
          requestedToolConfirmations: {
            'random-1': new ToolConfirmation({confirmed: true}),
          },
        },
      }),
    ];

    const normalized = normalizeIds(events);

    const args = normalized[1].content?.parts?.[0]?.functionCall?.args;
    expect(args).toEqual({
      originalFunctionCall: {id: 'fc-1', name: 'roll'},
      hints: [{id: 'fc-1'}],
    });
    expect(
      Object.keys(normalized[1].actions.requestedToolConfirmations),
    ).toEqual(['fc-1']);
  });

  it('leaves a call without an id out of the map', () => {
    const event = createEvent({
      author: 'agent',
      content: {role: 'model', parts: [{functionCall: {name: 'roll'}}]},
      longRunningToolIds: ['kept'],
    });

    const [normalized] = normalizeIds([event]);

    expect(normalized.content?.parts?.[0]?.functionCall?.id).toBe('fc-1');
    expect(normalized.longRunningToolIds).toEqual(['kept']);
  });

  it('cannot pair a response with a call that has no name', () => {
    const events = [
      createEvent({
        author: 'agent',
        content: {role: 'model', parts: [{functionCall: {id: 'random-1'}}]},
      }),
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {functionResponse: {name: 'roll', response: {}}},
            {functionResponse: {response: {}}},
          ],
        },
      }),
    ];

    const normalized = normalizeIds(events);

    const responses = normalized[1].content?.parts ?? [];
    expect(responses[0].functionResponse?.id).toBeUndefined();
    expect(responses[1].functionResponse?.id).toBeUndefined();
  });
});

describe('normalizeRebuiltEvents', () => {
  it('keeps the canonical ids and drops only what a rerun cannot reproduce', () => {
    const event: Event = createEvent({
      author: 'agent',
      id: 'e-1',
      invocationId: 'i-1',
      timestamp: 1234,
      usageMetadata: {totalTokenCount: 7},
      content: {role: 'model', parts: [{text: 'hi', thoughtSignature: 'x'}]},
    });

    expect(normalizeRebuiltEvents([event])).toEqual([
      {
        author: 'agent',
        id: 'e-1',
        invocationId: 'i-1',
        content: {role: 'model', parts: [{text: 'hi'}]},
      },
    ]);
  });

  it('keeps a non-empty long running tool id list, sorted', () => {
    const event = createEvent({
      author: 'agent',
      longRunningToolIds: ['fc-2', 'fc-1'],
    });

    expect(normalizeRebuiltEvents([event])[0]['longRunningToolIds']).toEqual([
      'fc-1',
      'fc-2',
    ]);
  });
});
