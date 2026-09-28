/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';

/**
 * Keys ADK never writes to a fixture. `toolsDict` holds live tool objects,
 * which is why adk-python declares `LlmRequest.tools_dict` with
 * `exclude=True`; YAML cannot represent the functions they carry.
 */
const EXCLUDED_KEYS: ReadonlySet<string> = new Set(['toolsDict']);

/**
 * Keys whose value is data ADK carries without reading it. The agent or the
 * test author chooses the keys inside them, so renaming those corrupts the
 * data. `eval_json.ts` applies the same rule on the core side.
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
 * Conformance fixtures are stored in snake_case and read back through
 * `camelcaseKeys(..., {deep: true})`, so this is the inverse the writer needs.
 * Arrays, `null` and primitives are returned as they are. A property whose
 * value is `undefined` is dropped, because YAML cannot represent it.
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

/** Writes `value` to `file` as a snake_case YAML document. */
export async function writeYamlFile(
  file: string,
  value: unknown,
): Promise<void> {
  const document = yaml.dump(toSnakeKeys(value), {
    noRefs: true,
    sortKeys: false,
    lineWidth: -1,
  });
  await fs.writeFile(file, document, 'utf-8');
}

function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
