/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {branchPathFromString} from '../workflow/branch_path.js';

import {Event, getFunctionCalls, getFunctionResponses} from './event.js';

/** The invocation an event selection is made from. */
export interface SessionEventFilterScope {
  /** The invocation id `currentInvocation` selects on. */
  invocationId: string;

  /**
   * The branch `currentBranch` selects on. `undefined` means "no branch", and
   * an empty string is a distinct, real branch value in the workflow code.
   */
  branch?: string;
}

/** Which filters to apply to a session's events. */
export interface SessionEventFilterOptions {
  /** Keep only events of the scope's invocation. */
  currentInvocation?: boolean;

  /** Keep only events belonging to the scope's branch subtree. */
  currentBranch?: boolean;
}

/**
 * Selects the events of a session that belong to `scope`.
 *
 * Ported from `google/adk-python` `InvocationContext._get_events`, which
 * carries a TODO asking for exactly this move to a module of its own. The
 * order and identity of the events are preserved, so a caller can compare the
 * result against the session's own event objects.
 *
 * @param events The session's events, oldest first.
 * @param scope The invocation and branch to select for.
 * @param options The filters to apply. With neither set, `events` is returned
 *   as it came in.
 * @returns The selected events, in their original order.
 */
export function filterSessionEvents(
  events: Event[],
  scope: SessionEventFilterScope,
  options: SessionEventFilterOptions = {},
): Event[] {
  let results = events;
  if (options.currentInvocation) {
    results = results.filter(
      (event) => event.invocationId === scope.invocationId,
    );
  }
  if (options.currentBranch) {
    // Gathered once per call: the ids depend on the session and the branch, not
    // on the event being tested, so gathering them inside the predicate would
    // rescan every session event once per user response event.
    const branchCallIds = scope.branch
      ? collectBranchCallIds(events, scope.branch)
      : new Set<string>();
    results = results.filter((event) =>
      isBranchMatch(event, scope, branchCallIds),
    );
  }
  return results;
}

/**
 * Finds the event issuing the function call `functionCallId`, searching
 * backwards from `endIndex`.
 *
 * Mirrors `google/adk-python` `find_event_by_function_call_id`.
 *
 * @param events The events to search, oldest first.
 * @param functionCallId The function call id to match.
 * @param endIndex The exclusive upper bound of the search. Defaults to the
 *   whole list.
 * @returns The issuing event, or `undefined` when no event issued that call.
 */
export function findEventByFunctionCallId(
  events: Event[],
  functionCallId: string,
  endIndex: number = events.length,
): Event | undefined {
  for (let i = endIndex - 1; i >= 0; i--) {
    const event = events[i];
    for (const functionCall of getFunctionCalls(event)) {
      if (functionCall.id === functionCallId) {
        return event;
      }
    }
  }
  return undefined;
}

/**
 * Finds the event issuing the call that the LAST event in `events` answers.
 *
 * Mirrors `google/adk-python` `find_matching_function_call`.
 *
 * @param events The events to search, oldest first, with the function-response
 *   event last.
 * @returns The issuing event, or `undefined` when the last event carries no
 *   identified function response, or nothing issued that call.
 */
export function findMatchingFunctionCall(events: Event[]): Event | undefined {
  if (!events.length) {
    return undefined;
  }
  const functionResponses = getFunctionResponses(events[events.length - 1]);
  if (!functionResponses.length || !functionResponses[0].id) {
    return undefined;
  }
  return findEventByFunctionCallId(
    events,
    functionResponses[0].id,
    events.length - 1,
  );
}

/**
 * Whether an event is part of the branch subtree `scope` describes.
 *
 * The rule differs by author, deliberately. A user event matches on this
 * branch, on a descendant sub-branch, or on no branch at all, and a scope with
 * no branch matches every user event. A user event carrying function responses
 * must additionally answer a call issued in this subtree, which is what keeps a
 * reply from leaking across parallel trees. Any other event must sit on exactly
 * this branch: widening it would hand every caller a descendant's internal
 * events, so it needs a per-caller review rather than a blanket change.
 */
function isBranchMatch(
  event: Event,
  scope: SessionEventFilterScope,
  branchCallIds: Set<string>,
): boolean {
  if (event.author !== 'user') {
    return event.branch === scope.branch;
  }
  if (scope.branch && !answersCallInScope(event, branchCallIds)) {
    return false;
  }
  return (
    event.branch === undefined ||
    scope.branch === undefined ||
    event.branch === scope.branch ||
    // The truthiness guard keeps an empty scope branch from matching every
    // branched event, which a bare descendant test would do.
    (!!scope.branch &&
      branchPathFromString(event.branch).isDescendantOf(
        branchPathFromString(scope.branch),
      ))
  );
}

/**
 * Whether a user event's function responses answer a call issued in the scope's
 * subtree. An event carrying no identified response answers nothing and is left
 * to the branch rule.
 */
function answersCallInScope(event: Event, branchCallIds: Set<string>): boolean {
  const responseIds = getFunctionResponses(event)
    .map((response) => response.id)
    .filter((id): id is string => id !== undefined);
  if (responseIds.length === 0) {
    return true;
  }
  return responseIds.some((id) => branchCallIds.has(id));
}

function collectBranchCallIds(events: Event[], branch: string): Set<string> {
  const descendantPrefix = `${branch}.`;
  const callIds = new Set<string>();
  for (const event of events) {
    if (
      !event.branch ||
      (event.branch !== branch && !event.branch.startsWith(descendantPrefix))
    ) {
      continue;
    }
    for (const call of getFunctionCalls(event)) {
      if (call.id) {
        callIds.add(call.id);
      }
    }
  }
  return callIds;
}
