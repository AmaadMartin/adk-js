/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  createEvent,
  filterSessionEvents,
  findEventByFunctionCallId,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const SCOPE = {invocationId: 'inv_1', branch: 'agent_1'};

function agentEvent(params: {
  invocationId?: string;
  branch?: string;
  author?: string;
}): Event {
  return createEvent({
    invocationId: params.invocationId ?? 'inv_1',
    author: params.author ?? 'some_agent',
    branch: params.branch,
  });
}

function userEvent(branch?: string, invocationId = 'inv_1'): Event {
  return createEvent({invocationId, author: 'user', branch});
}

/** A non-user event issuing the function call `callId` on `branch`. */
function callEvent(branch: string | undefined, callId: string): Event {
  return createEvent({
    invocationId: 'inv_1',
    author: 'some_agent',
    branch,
    content: {parts: [{functionCall: {id: callId, name: 't', args: {}}}]},
  });
}

/** A user event answering the function call `callId` on `branch`. */
function responseEvent(branch: string | undefined, callId: string): Event {
  return createEvent({
    invocationId: 'inv_1',
    author: 'user',
    branch,
    content: {
      parts: [{functionResponse: {id: callId, name: 't', response: {}}}],
    },
  });
}

describe('filterSessionEvents', () => {
  const first = agentEvent({invocationId: 'inv_1', branch: 'agent_1'});
  const second = agentEvent({invocationId: 'inv_1', branch: 'agent_2'});
  const third = agentEvent({invocationId: 'inv_2', branch: 'agent_1'});
  const fourth = agentEvent({invocationId: 'inv_2', branch: 'agent_2'});
  const all = [first, second, third, fourth];

  it('returns every event, unchanged, when no filter is asked for', () => {
    const results = filterSessionEvents(all, SCOPE);

    expect(results).toBe(all);
    expect(results[0]).toBe(first);
  });

  it('filters by the invocation id', () => {
    expect(filterSessionEvents(all, SCOPE, {currentInvocation: true})).toEqual([
      first,
      second,
    ]);
  });

  it('filters by the branch', () => {
    expect(filterSessionEvents(all, SCOPE, {currentBranch: true})).toEqual([
      first,
      third,
    ]);
  });

  it('applies both filters together', () => {
    expect(
      filterSessionEvents(all, SCOPE, {
        currentInvocation: true,
        currentBranch: true,
      }),
    ).toEqual([first]);
  });

  it('returns nothing for an empty session', () => {
    expect(
      filterSessionEvents([], SCOPE, {
        currentInvocation: true,
        currentBranch: true,
      }),
    ).toEqual([]);
  });

  it('returns nothing when no event matches', () => {
    const scope = {invocationId: 'inv_3', branch: 'branch_C'};

    expect(filterSessionEvents(all, scope, {currentInvocation: true})).toEqual(
      [],
    );
    expect(filterSessionEvents(all, scope, {currentBranch: true})).toEqual([]);
    expect(
      filterSessionEvents(all, scope, {
        currentInvocation: true,
        currentBranch: true,
      }),
    ).toEqual([]);
  });
});

describe('filterSessionEvents branch matching', () => {
  it('includes a user event on a descendant sub-branch', () => {
    const userOnChild = userEvent('agent_1.child');

    expect(
      filterSessionEvents([userOnChild], SCOPE, {currentBranch: true}),
    ).toEqual([userOnChild]);
  });

  it('excludes an agent event on a descendant sub-branch', () => {
    const agentOnChild = agentEvent({branch: 'agent_1.child'});

    expect(
      filterSessionEvents([agentOnChild], SCOPE, {currentBranch: true}),
    ).toEqual([]);
  });

  it('excludes a sibling branch', () => {
    const userOnSibling = userEvent('agent_2');

    expect(
      filterSessionEvents([userOnSibling], SCOPE, {currentBranch: true}),
    ).toEqual([]);
  });

  it('includes a user event carrying no branch', () => {
    const unbranched = userEvent(undefined);

    expect(
      filterSessionEvents([unbranched], SCOPE, {currentBranch: true}),
    ).toEqual([unbranched]);
  });

  it('matches no branched event when the scope branch is the empty string', () => {
    const userOnBranch = userEvent('agent_1');

    expect(
      filterSessionEvents(
        [userOnBranch],
        {invocationId: 'inv_1', branch: ''},
        {
          currentBranch: true,
        },
      ),
    ).toEqual([]);
  });

  it('matches every user event when the scope has no branch, and no agent event', () => {
    const userElsewhere = userEvent('agent_2.child');
    const agentElsewhere = agentEvent({branch: 'agent_2.child'});

    expect(
      filterSessionEvents(
        [userElsewhere, agentElsewhere],
        {invocationId: 'inv_1'},
        {currentBranch: true},
      ),
    ).toEqual([userElsewhere]);
  });

  it('keeps a user reply answering a call issued in this subtree', () => {
    const callHere = callEvent('agent_1.child', 'fc_1');
    const reply = responseEvent('agent_1', 'fc_1');

    expect(
      filterSessionEvents([callHere, reply], SCOPE, {currentBranch: true}),
    ).toEqual([reply]);
  });

  it('drops a user reply answering a call issued elsewhere', () => {
    const callElsewhere = callEvent('agent_2', 'fc_1');
    const reply = responseEvent('agent_1', 'fc_1');

    expect(
      filterSessionEvents([callElsewhere, reply], SCOPE, {
        currentBranch: true,
      }),
    ).toEqual([]);
  });

  it('judges each reply on one branch against its own call', () => {
    const callHere = callEvent('agent_1', 'fc_here');
    const callOnChild = callEvent('agent_1.child', 'fc_child');
    const callElsewhere = callEvent('agent_2', 'fc_far');
    const replyHere = responseEvent('agent_1', 'fc_here');
    const replyFar = responseEvent('agent_1', 'fc_far');
    const replyChild = responseEvent('agent_1', 'fc_child');

    const results = filterSessionEvents(
      [callHere, callOnChild, callElsewhere, replyHere, replyFar, replyChild],
      SCOPE,
      {currentBranch: true},
    );

    // `callHere` sits on exactly this branch, so the non-user rule returns it
    // too; the two sub-branch calls do not.
    expect(results).toEqual([callHere, replyHere, replyChild]);
    expect(results).not.toContain(replyFar);
  });

  it('keeps a user reply whose response carries no id', () => {
    const unidentified = createEvent({
      invocationId: 'inv_1',
      author: 'user',
      branch: 'agent_1',
      content: {parts: [{functionResponse: {name: 't', response: {}}}]},
    });

    expect(
      filterSessionEvents([unidentified], SCOPE, {currentBranch: true}),
    ).toEqual([unidentified]);
  });

  it('ignores a branch-local call that carries no id when gathering call ids', () => {
    const anonymousCall = createEvent({
      invocationId: 'inv_1',
      author: 'some_agent',
      branch: 'agent_1',
      content: {parts: [{functionCall: {name: 't', args: {}}}]},
    });
    const reply = responseEvent('agent_1', 'fc_1');

    expect(
      filterSessionEvents([anonymousCall, reply], SCOPE, {
        currentBranch: true,
      }),
    ).toEqual([anonymousCall]);
  });
});

describe('findEventByFunctionCallId', () => {
  it('returns the event issuing the call', () => {
    const call = callEvent('agent_1', 'fc_1');

    expect(findEventByFunctionCallId([call], 'fc_1')).toBe(call);
  });

  it('returns undefined when no event issued the call', () => {
    expect(
      findEventByFunctionCallId([callEvent('agent_1', 'fc_1')], 'fc_2'),
    ).toBeUndefined();
  });

  it('searches backwards and stops at endIndex', () => {
    const early = callEvent('agent_1', 'fc_1');
    const late = callEvent('agent_1', 'fc_1');

    expect(findEventByFunctionCallId([early, late], 'fc_1')).toBe(late);
    expect(findEventByFunctionCallId([early, late], 'fc_1', 1)).toBe(early);
  });
});
