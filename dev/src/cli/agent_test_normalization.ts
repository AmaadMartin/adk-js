/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Canonicalizes recorded and live agent events so that two runs of the same
 * conversation compare equal.
 *
 * Ports `normalize_events`, `make_sort_key`, `_normalize_ids` and
 * `_remap_node_path` from `google/adk-python`
 * `src/google/adk/cli/agent_test_runner.py`.
 */

import {
  BranchPath,
  Event,
  getFunctionCalls,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from '@google/adk';

/** A normalized event: a plain JSON object ready for comparison. */
export type NormalizedEvent = Record<string, unknown>;

/**
 * Event fields that differ between two runs of the same conversation, and are
 * therefore dropped before a live run is compared with a recorded fixture.
 */
export const EXCLUDED_EVENT_FIELDS: readonly string[] = [
  'id',
  'timestamp',
  'invocationId',
  'modelVersion',
  'finishReason',
  'usageMetadata',
  'avgLogprobs',
  'cacheMetadata',
  'logprobsResult',
  'citationMetadata',
  // The Interactions API issues `interactionId`, and only the live API emits
  // `turnComplete`.
  'interactionId',
  'turnComplete',
];

/**
 * Event fields a rebuilt fixture drops. Narrower than
 * {@link EXCLUDED_EVENT_FIELDS}: a rebuilt fixture keeps the ids it has just
 * made canonical, and loses only what a rerun cannot reproduce.
 */
const REBUILD_EXCLUDED_EVENT_FIELDS: readonly string[] = [
  'timestamp',
  'usageMetadata',
  'modelVersion',
  'avgLogprobs',
  'cacheMetadata',
  'logprobsResult',
  'citationMetadata',
  'interactionId',
  'turnComplete',
];

/** Function call names that make an event a human-in-the-loop request. */
const HITL_FUNCTION_CALL_NAMES: ReadonlySet<string> = new Set([
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
]);

/** Suffix of the `stateDelta` keys that hold parallel-join bookkeeping. */
const JOIN_STATE_SUFFIX = '_join_state';

/** Separator between the three parts of a {@link makeSortKey} result. */
const SORT_KEY_SEPARATOR = '\u0000';

/** Separator between the segments of a node path. */
const NODE_PATH_SEPARATOR = '/';

/** Separator between the segments of a branch. */
const BRANCH_SEPARATOR = '.';

/** Prefix of a branch that names the function call that dispatched a task. */
const TASK_BRANCH_PREFIX = 'task:';

/** Narrows a parsed JSON value to a plain object, rejecting arrays and `null`. */
export function asJsonObject(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Narrows a parsed JSON value to a string. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toSnakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Canonicalizes events for comparison.
 *
 * One code path serves both sides: a live {@link Event} and a recorded event
 * are both camelCase plain objects here, and a live event goes through JSON
 * first, which drops its `undefined` values and its non-serializable brand.
 *
 * @param events The live or recorded events to canonicalize.
 * @returns A canonicalized copy of each event. The inputs are not modified.
 */
export function normalizeEvents(events: readonly unknown[]): NormalizedEvent[] {
  return events.map(normalizeEvent);
}

function normalizeEvent(event: unknown): NormalizedEvent {
  const normalized = stripFields(event, EXCLUDED_EVENT_FIELDS);
  stripThoughtSignatures(normalized);
  dropHumanInTheLoopRole(normalized);
  normalizeLongRunningToolIds(normalized);
  pruneEmptyActionGroups(normalized);
  dropJoinStateKeys(normalized);
  return normalized;
}

/**
 * Canonicalizes the events of a rebuilt fixture for storage.
 *
 * A rebuild keeps the ids that a comparison ignores, so it applies only the
 * part of the comparison rules that a rerun cannot reproduce on its own.
 *
 * @param events The events produced by rerunning the recorded conversation.
 * @returns The JSON to store under the fixture's `events` key.
 */
export function normalizeRebuiltEvents(
  events: readonly Event[],
): NormalizedEvent[] {
  return events.map((event) => {
    const rebuilt = stripFields(event, REBUILD_EXCLUDED_EVENT_FIELDS);
    stripThoughtSignatures(rebuilt);
    // `createEvent` defaults this to `[]` where adk-python leaves it unset, so
    // a rebuilt fixture would otherwise carry the empty list on every event.
    normalizeLongRunningToolIds(rebuilt);
    pruneEmptyActionGroups(rebuilt);
    return rebuilt;
  });
}

/**
 * Returns the JSON view of an event without `excluded` fields and without
 * top-level nulls.
 *
 * Nulls are dropped at the top level only, as adk-python's non-recursive dict
 * comprehension does.
 */
function stripFields(
  event: unknown,
  excluded: readonly string[],
): NormalizedEvent {
  const stripped = JSON.parse(JSON.stringify(event)) as NormalizedEvent;
  for (const field of excluded) {
    delete stripped[field];
    // A hand-written fixture may spell the field `invocation_id`, as
    // adk-python's normalize_events also allows for.
    delete stripped[toSnakeCase(field)];
  }
  for (const [key, value] of Object.entries(stripped)) {
    if (value === null) {
      delete stripped[key];
    }
  }
  return stripped;
}

function contentParts(event: NormalizedEvent): Array<Record<string, unknown>> {
  const parts = asJsonObject(event['content'])?.['parts'];
  if (!Array.isArray(parts)) {
    return [];
  }
  return parts
    .map(asJsonObject)
    .filter((part): part is Record<string, unknown> => part !== undefined);
}

function stripThoughtSignatures(event: NormalizedEvent): void {
  for (const part of contentParts(event)) {
    delete part['thoughtSignature'];
  }
}

/** The role of a human-in-the-loop request is not stable across runs. */
function dropHumanInTheLoopRole(event: NormalizedEvent): void {
  const isRequest = contentParts(event).some((part) => {
    const name = asJsonObject(part['functionCall'])?.['name'];
    return typeof name === 'string' && HITL_FUNCTION_CALL_NAMES.has(name);
  });
  if (isRequest) {
    delete asJsonObject(event['content'])?.['role'];
  }
}

function normalizeLongRunningToolIds(event: NormalizedEvent): void {
  const ids = event['longRunningToolIds'];
  if (!Array.isArray(ids)) {
    return;
  }
  // The ids come from a set in adk-python, and `createEvent` defaults the
  // field to `[]`, which no fixture records.
  if (ids.length === 0) {
    delete event['longRunningToolIds'];
    return;
  }
  event['longRunningToolIds'] = [...ids].sort();
}

function pruneEmptyActionGroups(event: NormalizedEvent): void {
  const actions = asJsonObject(event['actions']);
  if (!actions) {
    return;
  }
  for (const [key, value] of Object.entries(actions)) {
    const group = asJsonObject(value);
    if (group && Object.keys(group).length === 0) {
      delete actions[key];
    }
  }
  if (Object.keys(actions).length === 0) {
    delete event['actions'];
  }
}

/** Join bookkeeping is an implementation detail of parallel execution. */
function dropJoinStateKeys(event: NormalizedEvent): void {
  const stateDelta = asJsonObject(
    asJsonObject(event['actions'])?.['stateDelta'],
  );
  if (!stateDelta) {
    return;
  }
  for (const key of Object.keys(stateDelta)) {
    if (key.endsWith(JOIN_STATE_SUFFIX)) {
      delete stateDelta[key];
    }
  }
}

/**
 * Returns a deep copy of `value` with the keys of every nested object sorted.
 *
 * `JSON.stringify` emits keys in insertion order, so this is what makes a
 * serialized event independent of the order its keys happened to be created
 * in.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  const object = asJsonObject(value);
  if (!object) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    sorted[key] = sortKeysDeep(object[key]);
  }
  return sorted;
}

/**
 * Builds the ordering key of a normalized event: its author, then its node
 * path, then the whole event serialized with sorted keys.
 *
 * Sorting both sides of a comparison by this key is what absorbs the
 * interleaving of concurrent workflow branches. The three parts are joined
 * with a NUL, which no event field contains, so comparing the keys as strings
 * reproduces the tuple comparison adk-python does.
 */
export function makeSortKey(event: NormalizedEvent): string {
  const author = event['author'];
  const path = asJsonObject(event['nodeInfo'])?.['path'];
  return [
    typeof author === 'string' ? author : '',
    typeof path === 'string' ? path : '',
    JSON.stringify(sortKeysDeep(event)),
  ].join(SORT_KEY_SEPARATOR);
}

/** Orders normalized events by {@link makeSortKey}, leaving the input alone. */
export function sortBySortKey(
  events: readonly NormalizedEvent[],
): NormalizedEvent[] {
  return [...events].sort((left, right) => {
    const leftKey = makeSortKey(left);
    const rightKey = makeSortKey(right);
    if (leftKey === rightKey) {
      return 0;
    }
    return leftKey < rightKey ? -1 : 1;
  });
}

/**
 * Drops partial events and rewrites every generated id to a canonical form:
 * `e-N` for events and `fc-N` for function calls, following those ids into
 * every place they are echoed — long-running tool ids, branches, isolation
 * scopes, node paths, nested call arguments, function responses and tool
 * confirmation keys.
 *
 * The events are modified in place, as adk-python's `_normalize_ids` does.
 *
 * @param events The live events of one replayed or rebuilt conversation.
 * @returns The retained events, in their original order.
 */
export function normalizeIds(events: Event[]): Event[] {
  const retained = events.filter((event) => !event.partial);
  retained.forEach((event, index) => {
    event.id = `e-${index + 1}`;
  });

  const idMap = assignFunctionCallIds(retained);
  const callIdsByName = new Map<string, string[]>();
  for (const event of retained) {
    collectCallIdsByName(event, callIdsByName);
    remapBranch(event, idMap);
    remapNodeInfo(event, idMap);
    remapContent(event, idMap, callIdsByName);
    remapToolConfirmations(event, idMap);
  }
  return retained;
}

/**
 * Numbers every function call `fc-N` in event order and returns the map from
 * the original id to the canonical one. The ids echoed on the same event — in
 * `longRunningToolIds` and in the call's own arguments — are rewritten here,
 * where the original id is still known.
 */
function assignFunctionCallIds(events: readonly Event[]): Map<string, string> {
  const idMap = new Map<string, string>();
  let counter = 0;

  for (const event of events) {
    for (const call of getFunctionCalls(event)) {
      const originalId = call.id;
      const newId = `fc-${++counter}`;
      call.id = newId;
      if (originalId === undefined) {
        continue;
      }
      idMap.set(originalId, newId);
      if (event.longRunningToolIds?.length) {
        event.longRunningToolIds = event.longRunningToolIds.map((id) =>
          id === originalId ? newId : id,
        );
      }
      const args = call.args;
      if (args) {
        for (const [key, value] of Object.entries(args)) {
          if (value === originalId) {
            args[key] = newId;
          }
        }
      }
    }
  }
  return idMap;
}

function collectCallIdsByName(
  event: Event,
  callIdsByName: Map<string, string[]>,
): void {
  for (const call of getFunctionCalls(event)) {
    if (call.name === undefined || call.id === undefined) {
      continue;
    }
    const ids = callIdsByName.get(call.name) ?? [];
    ids.push(call.id);
    callIdsByName.set(call.name, ids);
  }
}

function remapBranch(event: Event, idMap: ReadonlyMap<string, string>): void {
  if (!event.branch) {
    return;
  }
  // A task branch names the dispatching call directly rather than as a
  // `<name>@<id>` path segment.
  if (event.branch.startsWith(TASK_BRANCH_PREFIX)) {
    const mapped = idMap.get(event.branch.slice(TASK_BRANCH_PREFIX.length));
    if (mapped !== undefined) {
      event.branch = `${TASK_BRANCH_PREFIX}${mapped}`;
    }
  }
  const segments = new BranchPath(event.branch.split(BRANCH_SEPARATOR))
    .getSegments()
    .map((segment) => remapPathSegment(segment, idMap));
  event.branch = new BranchPath(segments).toString();
}

function remapNodeInfo(event: Event, idMap: ReadonlyMap<string, string>): void {
  // A task wrapper stamps the isolation scope and the node path with the id of
  // the call that dispatched it, which is random at run time.
  if (event.isolationScope !== undefined) {
    event.isolationScope =
      idMap.get(event.isolationScope) ?? event.isolationScope;
  }
  if (event.nodeInfo?.path) {
    event.nodeInfo.path = remapNodePath(event.nodeInfo.path, idMap);
  }
  if (event.nodeInfo?.outputFor) {
    event.nodeInfo.outputFor = event.nodeInfo.outputFor.map((path) =>
      remapNodePath(path, idMap),
    );
  }
}

/** Rewrites the `<name>@<id>` segments of a node path through `idMap`. */
function remapNodePath(
  path: string,
  idMap: ReadonlyMap<string, string>,
): string {
  return path
    .split(NODE_PATH_SEPARATOR)
    .map((segment) => remapPathSegment(segment, idMap))
    .join(NODE_PATH_SEPARATOR);
}

function remapPathSegment(
  segment: string,
  idMap: ReadonlyMap<string, string>,
): string {
  const at = segment.lastIndexOf('@');
  if (at < 0) {
    return segment;
  }
  const mapped = idMap.get(segment.slice(at + 1));
  return mapped === undefined ? segment : `${segment.slice(0, at)}@${mapped}`;
}

function remapContent(
  event: Event,
  idMap: ReadonlyMap<string, string>,
  callIdsByName: Map<string, string[]>,
): void {
  for (const part of event.content?.parts ?? []) {
    const response = part.functionResponse;
    if (response) {
      const pending =
        response.name === undefined
          ? undefined
          : callIdsByName.get(response.name);
      if (pending?.length) {
        response.id = pending.shift();
      } else if (response.id !== undefined) {
        response.id = idMap.get(response.id) ?? response.id;
      }
    }
    // A tool confirmation call nests the id of the call it confirms in its
    // arguments; remapping it is what lines the two events up.
    if (part.functionCall?.args) {
      remapIdsInArgs(part.functionCall.args, idMap);
    }
  }
}

function remapIdsInArgs(
  value: unknown,
  idMap: ReadonlyMap<string, string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      remapIdsInArgs(item, idMap);
    }
    return;
  }
  const object = asJsonObject(value);
  if (!object) {
    return;
  }
  for (const [key, nested] of Object.entries(object)) {
    const mapped =
      key === 'id' && typeof nested === 'string'
        ? idMap.get(nested)
        : undefined;
    if (mapped === undefined) {
      remapIdsInArgs(nested, idMap);
    } else {
      object[key] = mapped;
    }
  }
}

/** `requestedToolConfirmations` is keyed by the id of the pinned call. */
function remapToolConfirmations(
  event: Event,
  idMap: ReadonlyMap<string, string>,
): void {
  event.actions.requestedToolConfirmations = Object.fromEntries(
    Object.entries(event.actions.requestedToolConfirmations).map(
      ([id, confirmation]) => [idMap.get(id) ?? id, confirmation],
    ),
  );
}
