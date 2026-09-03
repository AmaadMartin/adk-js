/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import camelcaseKeys from 'camelcase-keys';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {RecordingsSchema} from '../integration/recordings_schema.js';
import {ReplayConfigError} from '../integration/replay_errors.js';
import {Recordings} from '../integration/test_types.js';
import {isFileExists} from '../utils/file_utils.js';

/**
 * The recordings file each streaming mode replays from.
 *
 * The names match adk-python's `ReplayPlugin._load_invocation_state`.
 */
const RECORDINGS_FILE_BY_STREAMING_MODE = new Map<string, string>([
  ['none', 'generated-recordings.yaml'],
  ['sse', 'generated-recordings-sse.yaml'],
]);

/**
 * Paths holding recorded user data rather than schema fields.
 *
 * A tool argument named `user_name` must load back as `user_name`. Otherwise
 * argument verification compares a camelized recording against the arguments
 * the runtime really passed, and rejects every snake_case argument name. The
 * paths use the file's own snake_case, and an array index is not a path
 * segment.
 */
const OPAQUE_VALUE_PATHS = [
  'recordings.tool_recording.tool_call.args',
  'recordings.tool_recording.tool_response.response',
];

/**
 * Reads the recordings a replay run of `dir` needs.
 *
 * @param dir The conformance test case directory.
 * @param streamingMode The mode the run replays, `none` or `sse`.
 * @throws Error when `streamingMode` names no recordings file.
 * @throws ReplayConfigError when the file is missing or does not load.
 */
export async function loadRecordings(
  dir: string,
  streamingMode: string,
): Promise<Recordings> {
  const fileName = RECORDINGS_FILE_BY_STREAMING_MODE.get(streamingMode);
  if (!fileName) {
    throw new Error(`Unsupported streaming mode: ${streamingMode}`);
  }

  const recordingsFile = path.join(dir, fileName);
  if (!(await isFileExists(recordingsFile))) {
    throw new ReplayConfigError(`Recordings file not found: ${recordingsFile}`);
  }

  try {
    const parsed = yaml.load(await fs.readFile(recordingsFile, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Recordings file must be a YAML mapping');
    }
    return RecordingsSchema.parse(
      camelcaseKeys(parsed, {deep: true, stopPaths: OPAQUE_VALUE_PATHS}),
    );
  } catch (e: unknown) {
    throw new ReplayConfigError(
      `Failed to load recordings from ${recordingsFile}: ${String(e)}`,
      {cause: e},
    );
  }
}
