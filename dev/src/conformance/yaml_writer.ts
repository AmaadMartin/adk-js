/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Keys ADK never writes to a fixture. `toolsDict` holds live tool objects,
 * which is why adk-python declares `LlmRequest.tools_dict` with
 * `exclude=True`; YAML cannot represent the functions they carry.
 */
const EXCLUDED_KEYS: ReadonlySet<string> = new Set(['toolsDict']);

/**
 * Keys whose value is data ADK carries without reading it. The agent or the
 * test author chooses the keys inside them, so renaming those corrupts the
 * data.
 */
const OPAQUE_VALUE_KEYS: ReadonlySet<string> = new Set([
  'args',
  'artifactDelta',
  'customMetadata',
  'initialState',
  'response',
  'stateDelta',
]);

/**
 * Converts every camelCase key of `value` to snake_case, recursively.
 *
 * Conformance fixtures are stored in snake_case, so this is the casing a
 * writer needs; {@link toCamelKeys} is its inverse. Arrays, `null` and
 * primitives are returned as they are. A property whose value is `undefined`
 * is dropped, because YAML cannot represent it.
 */
export function toSnakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toSnakeKeys);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined || EXCLUDED_KEYS.has(key)) {
      continue;
    }
    result[toSnakeCase(key)] = OPAQUE_VALUE_KEYS.has(key)
      ? child
      : toSnakeKeys(child);
  }
  return result;
}

/**
 * Converts every snake_case key of `value` to camelCase, recursively.
 *
 * This is the exact inverse of {@link toSnakeKeys}: it protects the same
 * opaque values, so a fixture that is read and written again keeps the keys
 * the agent or the test author chose. `camelcaseKeys(..., {deep: true})`
 * renames those too, which is why this exists.
 */
export function toCamelKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toCamelKeys);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const camelKey = toCamelCase(key);
    result[camelKey] = OPAQUE_VALUE_KEYS.has(camelKey)
      ? child
      : toCamelKeys(child);
  }
  return result;
}

/**
 * Writes `value` to `file` as a snake_case YAML document, creating the
 * directories it needs. adk-python's `dump_pydantic_to_yaml` also creates
 * them, so recording into a new test case directory works on both SDKs.
 */
export async function writeYamlFile(
  file: string,
  value: unknown,
): Promise<void> {
  const document = yaml.dump(toSnakeKeys(value), {
    noRefs: true,
    sortKeys: false,
    lineWidth: -1,
  });
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, document, 'utf-8');
}

function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function toCamelCase(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}
