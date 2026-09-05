/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StreamingMode} from '@google/adk';
import * as path from 'node:path';

/** Paths of the files a conformance recording writes into a test case. */
export interface GeneratedFilePaths {
  sessionFile: string;
  recordingsFile: string;
}

const GENERATED_FILE_NAMES: ReadonlyMap<StreamingMode, GeneratedFilePaths> =
  new Map([
    [
      StreamingMode.NONE,
      {
        sessionFile: 'generated-session.yaml',
        recordingsFile: 'generated-recordings.yaml',
      },
    ],
    [
      StreamingMode.SSE,
      {
        sessionFile: 'generated-session-sse.yaml',
        recordingsFile: 'generated-recordings-sse.yaml',
      },
    ],
  ]);

/**
 * Returns the generated file paths of a test case directory.
 *
 * Mirrors adk-python's `_generated_file_utils`: only the non-streaming and
 * the SSE fixture sets have names. Bidirectional streaming is a value the CLI
 * parses but no fixture set exists for it.
 *
 * @throws if `streamingMode` is neither `none` nor `sse`.
 */
export function generatedFilePaths(
  dir: string,
  streamingMode: StreamingMode,
): GeneratedFilePaths {
  const names = GENERATED_FILE_NAMES.get(streamingMode);
  if (!names) {
    throw new Error(`Unsupported streaming mode: ${streamingMode}`);
  }
  return {
    sessionFile: path.join(dir, names.sessionFile),
    recordingsFile: path.join(dir, names.recordingsFile),
  };
}
