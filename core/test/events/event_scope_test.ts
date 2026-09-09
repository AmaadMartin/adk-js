/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event, createEvent} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {eventsOnCurrentBranch} from '../../src/events/event_scope.js';

describe('eventsOnCurrentBranch', () => {
  function eventOn(branch?: string): Event {
    return createEvent({author: 'agent', branch});
  }

  it('returns the list untouched when there is no current branch', () => {
    const events = [eventOn('root.a@1'), eventOn('root.b@1')];

    expect(eventsOnCurrentBranch(events, undefined)).toBe(events);
  });

  it('returns the list untouched for an empty current branch', () => {
    const events = [eventOn('root.a@1'), eventOn('root.b@1')];

    expect(eventsOnCurrentBranch(events, '')).toBe(events);
  });

  it('keeps an event that carries no branch', () => {
    const branchless = eventOn();

    expect(eventsOnCurrentBranch([branchless], 'root.a@1')).toEqual([
      branchless,
    ]);
  });

  it('keeps an event on the current branch', () => {
    const here = eventOn('root.a@1');

    expect(eventsOnCurrentBranch([here], 'root.a@1')).toEqual([here]);
  });

  it('keeps an event on an ancestor branch', () => {
    const ancestor = eventOn('root');

    expect(eventsOnCurrentBranch([ancestor], 'root.a@1')).toEqual([ancestor]);
  });

  it('drops an event on a sibling branch', () => {
    expect(eventsOnCurrentBranch([eventOn('root.b@1')], 'root.a@1')).toEqual(
      [],
    );
  });

  it('drops an event on a descendant branch', () => {
    expect(
      eventsOnCurrentBranch([eventOn('root.a@1.child@1')], 'root.a@1'),
    ).toEqual([]);
  });

  it('drops a branch whose name only shares a prefix string', () => {
    expect(eventsOnCurrentBranch([eventOn('root.a')], 'root.a@1')).toEqual([]);
    expect(eventsOnCurrentBranch([eventOn('root.ab@1')], 'root.a@1')).toEqual(
      [],
    );
  });
});
