/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Session, StreamingMode} from '@google/adk';
import camelcaseKeys from 'camelcase-keys';
import fg from 'fast-glob';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {Recordings, TestInfo, TestSpec} from '../integration/test_types.js';
import {isFileNotFoundError} from '../utils/file_utils.js';

/**
 * Returns the recordings and session file names holding the goldens of the
 * given streaming mode.
 *
 * A test case carries one pair per mode, because an SSE run records the
 * partial responses a non-streaming run never produces.
 */
export function goldenFileNames(streamingMode: StreamingMode): {
  recordings: string;
  session: string;
} {
  switch (streamingMode) {
    case StreamingMode.SSE:
      return {
        recordings: 'generated-recordings-sse.yaml',
        session: 'generated-session-sse.yaml',
      };
    case StreamingMode.NONE:
      return {
        recordings: 'generated-recordings.yaml',
        session: 'generated-session.yaml',
      };
    default:
      throw new Error(`Unsupported streaming mode: ${streamingMode}`);
  }
}

/** Reads a YAML file and camel-cases its keys. */
async function loadYamlMapping<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = yaml.load(content);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${filePath} must be a YAML mapping`);
  }
  return camelcaseKeys(parsed, {deep: true}) as T;
}

/**
 * batchLoadYamlTestDefs will recursively search the directory given
 * and load all of the YAML files into in-memory config.
 */
export async function batchLoadYamlTestDefs(
  directory: string,
  streamingMode: StreamingMode,
): Promise<Map<string, TestInfo>> {
  // Tests have 3 parts:
  //
  // 1. spec.yaml - the defined test config and input
  // 2. generated-recordings[-sse].yaml - the recorded event information
  // 3. generated-session[-sse].yaml - the recorded session information
  //
  // The -sse goldens hold the StreamingMode.SSE recording of the same test.
  // Assume any directory with a spec.yaml is a test, and skip it when the
  // goldens of the selected mode were never recorded.
  const goldens = goldenFileNames(streamingMode);
  const files = fg.stream('**/spec.{yaml,yml}', {
    cwd: directory,
    absolute: true,
  });
  const tests = new Map<string, TestInfo>();

  for await (const file of files) {
    // Normalize paths to POSIX to ensure consistent behavior across platforms
    // and when handling Windows paths.
    const normalizedFile = (file as string).replaceAll('\\', '/');

    // Test directory
    const baseDir = path.posix.dirname(normalizedFile);

    // Make test names unique by including relative file path from given root dir
    const normalizedDir = directory.replaceAll('\\', '/');
    const relativePath = path.posix.relative(normalizedDir, baseDir);
    const parsedPath = path.posix.parse(relativePath);
    const name = path.posix.join(parsedPath.dir, parsedPath.name);

    // Spec file
    const testSpec = await loadYamlMapping<TestSpec>(
      path.posix.join(baseDir, 'spec.yaml'),
    );

    let session: Session;
    let recordings: Recordings;
    try {
      session = await loadYamlMapping<Session>(
        path.posix.join(baseDir, goldens.session),
      );
      recordings = await loadYamlMapping<Recordings>(
        path.posix.join(baseDir, goldens.recordings),
      );
    } catch (error: unknown) {
      if (isFileNotFoundError(error)) {
        console.log('Skipping test', name, '- no', streamingMode, 'goldens');
        continue;
      }
      throw error;
    }

    tests.set(name, {
      name: name,
      spec: testSpec,
      session: session,
      recordings: recordings,
    });

    console.log('loaded test', name, 'from', baseDir);
  }

  return tests;
}
