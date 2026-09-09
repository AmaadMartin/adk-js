/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StreamingMode} from '@google/adk';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {generatedFilePaths} from '../../src/conformance/generated_file_utils.js';

const CASE_DIR = path.join('tests', 'core', 'case');

describe('generatedFilePaths', () => {
  it('names the non-streaming pair for StreamingMode.NONE', () => {
    expect(generatedFilePaths(CASE_DIR, StreamingMode.NONE)).toEqual({
      sessionFile: path.join(CASE_DIR, 'generated-session.yaml'),
      recordingsFile: path.join(CASE_DIR, 'generated-recordings.yaml'),
    });
  });

  it('names the sse pair for StreamingMode.SSE', () => {
    expect(generatedFilePaths(CASE_DIR, StreamingMode.SSE)).toEqual({
      sessionFile: path.join(CASE_DIR, 'generated-session-sse.yaml'),
      recordingsFile: path.join(CASE_DIR, 'generated-recordings-sse.yaml'),
    });
  });

  it('rejects a streaming mode that has no fixture set', () => {
    expect(() => generatedFilePaths(CASE_DIR, StreamingMode.BIDI)).toThrow(
      'Unsupported streaming mode: bidi',
    );
  });
});
