/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StreamingMode} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';

/**
 * Keys ADK never serializes. `toolsDict` holds live tool objects, which is why
 * adk-python declares `LlmRequest.tools_dict` with `exclude=True` and why
 * adk-js documents it as excluded from JSON serialization.
 */
const EXCLUDED_KEYS: ReadonlySet<string> = new Set(['toolsDict']);

/**
 * Keys whose value is data ADK carries without reading it: session state, the
 * arguments of a tool call, the response of a tool. The agent or the test
 * author chooses those keys, so rewriting them corrupts the data, and dropping
 * a `null` inside one deletes a value the agent produced.
 */
const VERBATIM_KEYS: ReadonlySet<string> = new Set([
  'args',
  'artifactDelta',
  'customMetadata',
  'response',
  'state',
  'stateDelta',
]);

/**
 * Keys whose value maps a name the user chose to an object ADK does read. The
 * names stay as written and the objects are still converted. The one that
 * reaches a generated file is `properties` of a function declaration's
 * parameter schema, whose members carry schema keywords such as `anyOf`.
 */
const NAMED_OBJECT_MAP_KEYS: ReadonlySet<string> = new Set(['properties']);

/** The generated file names of a test case, per streaming mode. */
export interface GeneratedFileNames {
  sessionFile: string;
  recordingsFile: string;
}

/**
 * Returns the names adk-python gives the generated files of a test case.
 *
 * @throws if `streamingMode` is neither `none` nor `sse`. Bidirectional
 *     streaming has no generated file names in either SDK.
 */
export function generatedFileNames(
  streamingMode: StreamingMode,
): GeneratedFileNames {
  switch (streamingMode) {
    case StreamingMode.NONE:
      return {
        sessionFile: 'generated-session.yaml',
        recordingsFile: 'generated-recordings.yaml',
      };
    case StreamingMode.SSE:
      return {
        sessionFile: 'generated-session-sse.yaml',
        recordingsFile: 'generated-recordings-sse.yaml',
      };
    default:
      throw new Error(`Unsupported streaming mode: ${streamingMode}`);
  }
}

/**
 * Writes `value` to `file` as a generated conformance file.
 *
 * The document matches what adk-python's `dump_pydantic_to_yaml` writes, so a
 * golden recorded by either SDK reads the same: keys in snake_case, a property
 * omitted when its value is `undefined` or `null` (Python dumps with
 * `exclude_none=True`), and keys in the order they were declared.
 */
export async function writeGeneratedYaml(
  file: string,
  value: unknown,
): Promise<void> {
  const document = yaml.dump(toGeneratedFileShape(value), {
    noRefs: true,
    sortKeys: false,
    lineWidth: -1,
  });
  await fs.writeFile(file, document, 'utf-8');
}

function toGeneratedFileShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toGeneratedFileShape);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined || child === null || EXCLUDED_KEYS.has(key)) {
      continue;
    }
    if (VERBATIM_KEYS.has(key)) {
      result[toSnakeCaseKey(key)] = child;
    } else if (NAMED_OBJECT_MAP_KEYS.has(key)) {
      result[toSnakeCaseKey(key)] = toNamedObjectMapShape(child);
    } else {
      result[toSnakeCaseKey(key)] = toGeneratedFileShape(child);
    }
  }
  return result;
}

function toNamedObjectMapShape(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, member]) => [
      name,
      toGeneratedFileShape(member),
    ]),
  );
}

function toSnakeCaseKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
