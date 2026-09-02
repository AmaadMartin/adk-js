/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type Session, StreamingMode} from '@google/adk';
import camelcaseKeys from 'camelcase-keys';
import fg from 'fast-glob';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  Recordings,
  TestCaseSpec,
  TestInfo,
  TestSpec,
} from '../integration/test_types.js';
import {generatedFilePaths} from './generated_file_utils.js';

/**
 * Paths in `spec.yaml` that hold user data ADK passes through verbatim. Their
 * keys are chosen by the test author, so camelCasing them corrupts the data.
 * A `stopPath` still renames the matched key and skips only its value subtree.
 */
const SPEC_OPAQUE_PATHS = [
  'initial_state',
  'user_messages.state_delta',
  'user_messages.content.parts.function_call.args',
  'user_messages.content.parts.function_response.response',
];

/**
 * Paths in `generated-session.yaml` that hold user data ADK passes through
 * verbatim: the session's own `state`, plus the list core preserves on an
 * event (`PRESERVE_KEYS_SNAKE_CASE` in `core/src/events/event.ts`) scoped
 * under `events.`.
 *
 * Two entries of core's list are left out on purpose.
 * `actions.requested_auth_configs` has opaque function-call ids for keys but
 * `AuthConfig` values whose fields are camelCase in adk-js. A `stopPath`
 * freezes a whole subtree, so preserving those keys would strand the values in
 * snake_case. `route` holds a scalar or an array of scalars, so it has no keys
 * to preserve. `requested_tool_confirmations` has neither problem: its fields
 * are single words and its `payload` is opaque by design.
 */
const SESSION_OPAQUE_PATHS = [
  'state',
  'events.actions.state_delta',
  'events.actions.artifact_delta',
  'events.actions.requested_tool_confirmations',
  'events.actions.custom_metadata',
  'events.custom_metadata',
  'events.content.parts.function_call.args',
  'events.content.parts.function_response.response',
  'events.output',
  'events.actions.agent_state',
];

/**
 * Paths in `generated-recordings.yaml` that hold user data ADK passes through
 * verbatim. The replay plugin returns these payloads to the running agent, so
 * a rewritten key changes what the agent runs on, not only what it compares to.
 */
const RECORDINGS_OPAQUE_PATHS = [
  'recordings.llm_recording.llm_request.contents.parts.function_call.args',
  'recordings.llm_recording.llm_request.contents.parts.function_response.response',
  'recordings.llm_recording.llm_response.content.parts.function_call.args',
  'recordings.llm_recording.llm_response.content.parts.function_response.response',
  'recordings.llm_recording.llm_response.custom_metadata',
  'recordings.tool_recording.tool_call.args',
  'recordings.tool_recording.tool_response.response',
];

/**
 * Loads the human-authored half of a test case, its `spec.yaml`.
 *
 * `adk integration record` needs this on its own: it writes the two generated
 * files `batchLoadYamlTestDefs` also reads, so it cannot use that loader on a
 * test case nobody has recorded yet.
 */
export async function loadTestSpec(specFile: string): Promise<TestSpec> {
  return loadYamlMapping<TestSpec>(specFile, 'Spec', SPEC_OPAQUE_PATHS);
}

/**
 * Recursively finds every `spec.{yaml,yml}` under `directory`, as absolute
 * POSIX paths. Both conformance commands treat a directory holding one as a
 * test case.
 */
export async function* streamSpecFiles(
  directory: string,
): AsyncGenerator<string> {
  const files = fg.stream('**/spec.{yaml,yml}', {
    cwd: directory,
    absolute: true,
  });

  for await (const file of files) {
    // Normalize paths to POSIX to ensure consistent behavior across platforms
    // and when handling Windows paths.
    yield (file as string).replaceAll('\\', '/');
  }
}

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
  const testCases: TestCaseSpec[] = [];

  for await (const normalizedFile of streamSpecFiles(directory)) {
    const baseDir = path.posix.dirname(normalizedFile);
    const spec = await loadTestSpec(normalizedFile);

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
    session: await loadYamlMapping<Session>(
      sessionFile,
      'Session',
      SESSION_OPAQUE_PATHS,
    ),
    recordings: await loadYamlMapping<Recordings>(
      recordingsFile,
      'Recording',
      RECORDINGS_OPAQUE_PATHS,
    ),
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

/**
 * Reads one YAML mapping and camelCases its keys.
 *
 * `stopPaths` names the subtrees that hold user data, which keep the keys the
 * test author wrote.
 */
async function loadYamlMapping<T>(
  file: string,
  label: string,
  stopPaths: readonly string[],
): Promise<T> {
  const content = await fs.readFile(file, 'utf-8');
  const parsed = yaml.load(content);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${label} file must be a YAML mapping`);
  }
  return camelcaseKeys(parsed, {deep: true, stopPaths}) as T;
}
