/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  EventBranchTrie,
  filterEventsByBranch,
} from '../../src/events/branch_trie.js';
import {createEvent} from '../../src/events/event.js';

describe('EventBranchTrie', () => {
  it('should insert and query events with no branch, simple branches, and nested branches', () => {
    const rootEvent = createEvent({author: 'user'}); // no branch
    const simpleEvent = createEvent({author: 'agent1', branch: 'root'});
    const nestedEvent = createEvent({
      author: 'subAgent',
      branch: 'root.agentA.sub1',
    });

    const trie = new EventBranchTrie();
    trie.insert(rootEvent);
    trie.insert(simpleEvent);
    trie.insert(nestedEvent);

    expect(trie.root.events).toEqual([rootEvent]);
    expect(trie.root.children.get('root')?.events).toEqual([simpleEvent]);
    expect(
      trie.root.children
        .get('root')
        ?.children.get('agentA')
        ?.children.get('sub1')?.events,
    ).toEqual([nestedEvent]);
  });

  it('should return only root/global events when currentBranch is undefined or empty', () => {
    const rootEvent1 = createEvent({author: 'user'});
    const rootEvent2 = createEvent({author: 'user', branch: ''});
    const branchEvent = createEvent({author: 'agent1', branch: 'root.agentA'});

    const trie = EventBranchTrie.fromEvents([
      rootEvent1,
      rootEvent2,
      branchEvent,
    ]);

    expect(trie.getMatchingEvents(undefined)).toEqual([rootEvent1, rootEvent2]);
    expect(trie.getMatchingEvents('')).toEqual([rootEvent1, rootEvent2]);
  });

  it('should return root, ancestor, and target branch events in correct insertion order when querying a nested branch', () => {
    const rootEvent = createEvent({author: 'user', timestamp: 1});
    const level1Event = createEvent({
      author: 'coord',
      branch: 'root',
      timestamp: 2,
    });
    const level2Event = createEvent({
      author: 'agentA',
      branch: 'root.agentA',
      timestamp: 3,
    });
    const level3Event = createEvent({
      author: 'sub1',
      branch: 'root.agentA.sub1',
      timestamp: 4,
    });

    const trie = EventBranchTrie.fromEvents([
      level3Event,
      rootEvent,
      level2Event,
      level1Event,
    ]);

    const matches = trie.getMatchingEvents('root.agentA.sub1');
    expect(matches).toEqual([level3Event, rootEvent, level2Event, level1Event]);
  });

  it('should exclude sibling branches and child branches beyond currentBranch', () => {
    const rootEvent = createEvent({author: 'user'});
    const targetEvent = createEvent({
      author: 'agentA',
      branch: 'root.agentA.sub1',
    });
    const siblingEvent = createEvent({
      author: 'agentB',
      branch: 'root.agentB.sub1',
    });
    const deepChildEvent = createEvent({
      author: 'deep',
      branch: 'root.agentA.sub1.deepChild',
    });

    const trie = EventBranchTrie.fromEvents([
      rootEvent,
      targetEvent,
      siblingEvent,
      deepChildEvent,
    ]);

    const matches = trie.getMatchingEvents('root.agentA.sub1');
    expect(matches).toEqual([rootEvent, targetEvent]);
    expect(matches).not.toContain(siblingEvent);
    expect(matches).not.toContain(deepChildEvent);
  });

  it('should enforce boundary-aware segment matching so agent1 does not match agent10', () => {
    const rootEvent = createEvent({author: 'user'});
    const agent1Event = createEvent({author: 'a1', branch: 'agent1'});
    const agent10Event = createEvent({author: 'a10', branch: 'agent10'});

    const trie = EventBranchTrie.fromEvents([
      rootEvent,
      agent1Event,
      agent10Event,
    ]);

    const matches1 = trie.getMatchingEvents('agent1');
    expect(matches1).toEqual([rootEvent, agent1Event]);

    const matches10 = trie.getMatchingEvents('agent10');
    expect(matches10).toEqual([rootEvent, agent10Event]);
  });

  it('should handle empty or malformed branch strings gracefully without errors', () => {
    const malformedEvent1 = createEvent({
      author: 'a',
      branch: '.root..agentA.',
    });
    const malformedEvent2 = createEvent({
      author: 'b',
      branch: '   ..   ',
    });

    const trie = new EventBranchTrie();
    trie.insert(malformedEvent1);
    trie.insert(malformedEvent2);

    expect(trie.getMatchingEvents('root.agentA')).toEqual([
      malformedEvent1,
      malformedEvent2,
    ]);
    expect(trie.getMatchingEvents('.root..agentA.')).toEqual([
      malformedEvent1,
      malformedEvent2,
    ]);
    expect(trie.root.events).toEqual([malformedEvent2]);
  });

  it('should handle querying paths that do not exist in the Trie or have intermediate nodes with no events', () => {
    const rootEvent = createEvent({author: 'user'});
    const deepEvent = createEvent({
      author: 'deep',
      branch: 'root.intermediate.target',
    });

    const trie = EventBranchTrie.fromEvents([rootEvent, deepEvent]);

    // Querying intermediate node (exists but has 0 events of its own)
    expect(trie.getMatchingEvents('root.intermediate')).toEqual([rootEvent]);

    // Querying completely non-existent path
    expect(trie.getMatchingEvents('root.nonExistent')).toEqual([rootEvent]);

    // Querying deeper than existing path
    expect(trie.getMatchingEvents('root.intermediate.target.extra')).toEqual([
      rootEvent,
      deepEvent,
    ]);
  });

  it('should not update insert order if the exact same event object is inserted twice', () => {
    const event1 = createEvent({author: 'user', branch: 'root'});
    const event2 = createEvent({author: 'user', branch: 'root.child'});

    const trie = new EventBranchTrie();
    trie.insert(event1);
    trie.insert(event2);
    trie.insert(event1); // insert same event again

    expect(trie.getMatchingEvents('root.child')).toEqual([
      event1,
      event1,
      event2,
    ]);
  });

  it('should fallback to timestamp sorting when eventInsertOrder is missing for an event', () => {
    const event1 = createEvent({author: 'user', timestamp: 100});
    const event2 = createEvent({
      author: 'agent',
      branch: 'root',
      timestamp: 200,
    });

    const trie = new EventBranchTrie();
    // Manually push events bypassing insert() so eventInsertOrder is not set
    trie.root.events.push(event1);
    trie.root.children.set('root', {
      children: new Map(),
      events: [event2],
    });

    expect(trie.getMatchingEvents('root')).toEqual([event1, event2]);
  });

  it('should filter events using the standalone filterEventsByBranch function', () => {
    const rootEvent = createEvent({author: 'user'});
    const matchEvent = createEvent({author: 'agent1', branch: 'root.agentA'});
    const otherEvent = createEvent({author: 'agent2', branch: 'root.agentB'});

    const filtered = filterEventsByBranch(
      [rootEvent, matchEvent, otherEvent],
      'root.agentA',
    );
    expect(filtered).toEqual([rootEvent, matchEvent]);
  });
});
