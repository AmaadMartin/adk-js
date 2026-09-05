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
import {
  Recordings,
  TestCaseSpec,
  TestInfo,
  TestSpec,
} from '../integration/test_types.js';
import {generatedFilePaths} from './generated_file_utils.js';

/**
 * batchLoadTestSpecs will recursively search the directory given and load the
 * spec.yaml of every test case it finds.
 *
 * The generated files are not read, so a case that was never recorded is still
 * returned. `adk conformance record` needs exactly that.
 */
export async function batchLoadTestSpecs(
  directory: string,
): Promise<TestCaseSpec[]> {
  const files = fg.stream('**/spec.{yaml,yml}', {
    cwd: directory,
    absolute: true,
  });
  const testCases: TestCaseSpec[] = [];

  for await (const file of files) {
    // Normalize paths to POSIX to ensure consistent behavior across platforms
    // and when handling Windows paths.
    const normalizedFile = (file as string).replaceAll('\\', '/');
    const baseDir = path.posix.dirname(normalizedFile);
    const spec = await loadYamlMapping<TestSpec>(normalizedFile, 'Spec');

    // Make test names unique by including relative file path from given root dir
    const normalizedDir = directory.replaceAll('\\', '/');
    const relativePath = path.posix.relative(normalizedDir, baseDir);
    const parsedPath = path.posix.parse(relativePath);
    const name = path.posix.join(parsedPath.dir, parsedPath.name);

    testCases.push({
      name,
      dir: baseDir,
      category: name.includes('/') ? name.split('/')[0] : '',
      spec,
    });
  }

  return testCases;
}

/**
 * Reads the recorded session and recordings of a test case.
 *
 * @throws if either generated file is missing or is not a YAML mapping.
 */
export async function loadTestInfo(
  testCase: TestCaseSpec,
  streamingMode: StreamingMode,
): Promise<TestInfo> {
  const {sessionFile, recordingsFile} = generatedFilePaths(
    testCase.dir,
    streamingMode,
  );
  return {
    ...testCase,
    session: await loadYamlMapping<Session>(sessionFile, 'Session'),
    recordings: await loadYamlMapping<Recordings>(recordingsFile, 'Recording'),
  };
}

/**
 * batchLoadYamlTestDefs will recursively search the directory given
 * and load all of the YAML files into in-memory config.
 */
export async function batchLoadYamlTestDefs(
  directory: string,
): Promise<Map<string, TestInfo>> {
  // Tests have 3 parts:
  //
  // 1. spec.yaml - the defined test config and input
  // 2. generated-recordings.yaml - the recorded event information
  // 3. generated-session.yaml - the recorded session information
  //
  // Assume any directory with a spec.yaml is a test with all 3 files
  const tests = new Map<string, TestInfo>();

  for (const testCase of await batchLoadTestSpecs(directory)) {
    tests.set(testCase.name, await loadTestInfo(testCase, StreamingMode.NONE));
    console.log('loaded test', testCase.name, 'from', testCase.dir);
  }

  return tests;
}

async function loadYamlMapping<T>(file: string, label: string): Promise<T> {
  const content = await fs.readFile(file, 'utf-8');
  const parsed = yaml.load(content);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${label} file must be a YAML mapping`);
  }
  return camelcaseKeys(parsed, {deep: true}) as T;
}
