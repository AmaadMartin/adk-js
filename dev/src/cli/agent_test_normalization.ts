/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Canonicalisation of recorded and live agent events so that two runs of the
 * same conversation compare equal.
 *
 * Ports `normalize_events`, `make_sort_key`, `_normalize_ids` and
 * `_remap_node_path` from adk-python's `cli/agent_test_runner.py`.
 */

import {
  Event,
  getFunctionCalls,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from '@google/adk';

/** A parsed-JSON container: a recorded event or one of its nested objects. */
export type JsonObject = Record<string, unknown>;

/** An event entering normalisation: a live {@link Event} or recorded JSON. */
export type NormalizableEvent = Partial<Event> | JsonObject;

/** Separator between the segments of a node path and of a branch. */
export const PATH_SEPARATOR = '.';

/** Function call names that make an event a human-in-the-loop request. */
const HITL_FUNCTION_CALL_NAMES: ReadonlySet<string> = new Set([
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
]);

/** Event fields that differ between two runs of the same conversation. */
const EXCLUDED_EVENT_FIELDS: readonly string[] = [
  'id',
  'timestamp',
  'invocationId',
  'modelVersion',
  'finishReason',
  'usageMetadata',
  'citationMetadata',
  'interactionId',
  'turnComplete',
];

/**
 * Event fields dropped when a fixture is rebuilt.
 *
 * Narrower than {@link EXCLUDED_EVENT_FIELDS}: a rebuilt fixture keeps its
 * canonical `id` and `invocationId`, and only loses what a rerun cannot
 * reproduce.
 */
const REBUILD_EXCLUDED_EVENT_FIELDS: readonly string[] = [
  'timestamp',
  'usageMetadata',
  'modelVersion',
  'citationMetadata',
  'interactionId',
  'turnComplete',
];

/** Suffix of the `stateDelta` keys that hold parallel-join bookkeeping. */
const JOIN_STATE_SUFFIX = '_join_state';

/**
 * Narrows a value to a plain JSON object, or `undefined` when it is an array,
 * `null`, or not an object at all.
 */
function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/**
 * Canonicalises events for comparison.
 *
 * A live {@link Event} is already a plain camelCase object, so one code path
 * serves both sides: `JSON.parse(JSON.stringify(event))` produces the same
 * view of a live event as the fixture holds for a recorded one, dropping
 * `undefined` values and the non-serialisable event brand along the way.
 *
 * @param events The live or recorded events to canonicalise.
 * @returns A canonicalised copy of each event. The inputs are not modified.
 */
export function normalizeEvents(
  events: ReadonlyArray<NormalizableEvent>,
): JsonObject[] {
  return events.map(normalizeEvent);
}

function normalizeEvent(event: NormalizableEvent): JsonObject {
  const normalized = dropFields(event, EXCLUDED_EVENT_FIELDS);
  stripThoughtSignatures(normalized);
  dropHitlContentRole(normalized);
  normalizeLongRunningToolIds(normalized);
  pruneEmptyActionGroups(normalized);
  dropJoinStateKeys(normalized);
  return normalized;
}

/**
 * Canonicalises the events of a rebuilt fixture for serialisation.
 *
 * Rebuild keeps the ids that replay ignores, so it applies only the subset of
 * the comparison rules that a rerun cannot reproduce on its own.
 *
 * @param events The events produced by rerunning the recorded conversation.
 * @returns The JSON to store under the fixture's `events` key.
 */
export function normalizeRebuiltEvents(
  events: ReadonlyArray<NormalizableEvent>,
): JsonObject[] {
  return events.map((event) => {
    const rebuilt = dropFields(event, REBUILD_EXCLUDED_EVENT_FIELDS);
    stripThoughtSignatures(rebuilt);
    pruneEmptyActionGroups(rebuilt);
    return rebuilt;
  });
}

/**
 * Returns the JSON view of an event without `excluded` fields and without
 * top-level nulls.
 *
 * Serialising through JSON is what makes one code path serve both a live
 * {@link Event} and recorded JSON: it drops `undefined` values and the
 * non-serialisable event brand, leaving the same shape the fixture holds.
 * Nulls are dropped at the top level only, matching adk-python's
 * non-recursive dict comprehension.
 */
function dropFields(
  event: NormalizableEvent,
  excluded: readonly string[],
): JsonObject {
  const json = JSON.parse(JSON.stringify(event)) as JsonObject;
  for (const field of excluded) {
    delete json[field];
  }
  for (const [key, value] of Object.entries(json)) {
    if (value === null) {
      delete json[key];
    }
  }
  return json;
}

function contentParts(event: JsonObject): JsonObject[] {
  const parts = asObject(event['content'])?.['parts'];
  if (!Array.isArray(parts)) {
    return [];
  }
  return parts.map(asObject).filter((part) => part !== undefined);
}

function stripThoughtSignatures(event: JsonObject): void {
  for (const part of contentParts(event)) {
    delete part['thoughtSignature'];
  }
}

/** The role of a human-in-the-loop request is not stable across runs. */
function dropHitlContentRole(event: JsonObject): void {
  const content = asObject(event['content']);
  const isHitlRequest = contentParts(event).some((part) => {
    const name = asObject(part['functionCall'])?.['name'];
    return typeof name === 'string' && HITL_FUNCTION_CALL_NAMES.has(name);
  });
  if (content && isHitlRequest) {
    delete content['role'];
  }
}

function normalizeLongRunningToolIds(event: JsonObject): void {
  const ids = event['longRunningToolIds'];
  if (!Array.isArray(ids)) {
    return;
  }
  // `createEvent` defaults this to `[]`, which no fixture records.
  if (ids.length === 0) {
    delete event['longRunningToolIds'];
    return;
  }
  event['longRunningToolIds'] = [...ids].sort();
}

function pruneEmptyActionGroups(event: JsonObject): void {
  const actions = asObject(event['actions']);
  if (!actions) {
    return;
  }
  for (const [key, value] of Object.entries(actions)) {
    const group = asObject(value);
    if (group && Object.keys(group).length === 0) {
      delete actions[key];
    }
  }
  if (Object.keys(actions).length === 0) {
    delete event['actions'];
  }
}

/** Join bookkeeping is an implementation detail of parallel execution. */
function dropJoinStateKeys(event: JsonObject): void {
  const stateDelta = asObject(asObject(event['actions'])?.['stateDelta']);
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
 * `JSON.stringify` emits keys in insertion order, so this is what makes both
 * the comparison sort key and a rebuilt fixture independent of the order the
 * keys happened to be created in.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  const object = asObject(value);
  if (!object) {
    return value;
  }
  const sorted: JsonObject = {};
  for (const key of Object.keys(object).sort()) {
    sorted[key] = sortKeysDeep(object[key]);
  }
  return sorted;
}

function stableStringify(value: JsonObject): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Builds the ordering key of a normalised event: author, then node path, then
 * the whole event serialised with sorted keys.
 */
export function makeSortKey(event: JsonObject): [string, string, string] {
  const author = event['author'];
  const path = asObject(event['nodeInfo'])?.['path'];
  return [
    typeof author === 'string' ? author : '',
    typeof path === 'string' ? path : '',
    stableStringify(event),
  ];
}

/**
 * Compares two normalised events by their {@link makeSortKey}, for
 * `Array.prototype.sort`. Sorting both sides is what absorbs the interleaving
 * of concurrent workflow branches.
 */
export function compareSortKeys(a: JsonObject, b: JsonObject): number {
  const left = makeSortKey(a);
  const right = makeSortKey(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return left[i] < right[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Rewrites the `<name>@<id>` segments of a dotted path using `idMap`.
 *
 * Node paths and branches share this format, so both go through this function.
 * Segments without `@`, and ids absent from `idMap`, pass through unchanged.
 */
export function remapNodePath(
  path: string,
  idMap: ReadonlyMap<string, string>,
): string {
  return path
    .split(PATH_SEPARATOR)
    .map((segment) => remapPathSegment(segment, idMap))
    .join(PATH_SEPARATOR);
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

/**
 * Drops partial events and rewrites every generated id to a canonical form:
 * `e-N` for events and `fc-N` for function calls, including every place an id
 * is echoed (long-running tool ids, branches, isolation scopes, node paths,
 * nested call arguments, function responses and confirmation keys).
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
 * Assigns `fc-N` to every function call in event order and returns the
 * original-to-canonical id map. Ids echoed on the same event — in
 * `longRunningToolIds` and in the call's own arguments — are rewritten here,
 * where the original id is still known.
 */
function assignFunctionCallIds(events: Event[]): Map<string, string> {
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
      if (!args) {
        continue;
      }
      for (const [key, value] of Object.entries(args)) {
        if (value === originalId) {
          args[key] = newId;
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
  // A task branch names the dispatching call directly rather than as a path
  // segment.
  if (event.branch.startsWith('task:')) {
    const mapped = idMap.get(event.branch.split(':')[1]);
    if (mapped !== undefined) {
      event.branch = `task:${mapped}`;
    }
  }
  event.branch = remapNodePath(event.branch, idMap);
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
    // A tool-confirmation call nests the id of the call it confirms in its
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
  const object = asObject(value);
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
