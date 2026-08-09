/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {PRESERVE_KEYS_SNAKE_CASE, Session} from '@google/adk';
import camelcaseKeys from 'camelcase-keys';
import fg from 'fast-glob';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {Recordings, TestInfo, TestSpec} from '../integration/test_types.js';

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
 * verbatim: the list core preserves on an event, rooted at the session
 * document, plus the session's own `state`. Deriving it keeps this loader in
 * step whenever core starts preserving another path.
 */
const SESSION_OPAQUE_PATHS = [
  'state',
  ...PRESERVE_KEYS_SNAKE_CASE.map((key) => `events.${key}`),
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
 * Reads one YAML document of a test case and camelCases its struct field
 * names, leaving the subtrees named by `stopPaths` verbatim.
 *
 * @param label names the document in the error a non-mapping document raises.
 */
async function loadYamlMapping<T>(
  filePath: string,
  label: string,
  stopPaths: string[],
): Promise<T> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = yaml.load(content);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${label} file must be a YAML mapping`);
  }
  return camelcaseKeys(parsed, {deep: true, stopPaths}) as T;
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

    const testSpec = await loadYamlMapping<TestSpec>(
      path.posix.join(baseDir, 'spec.yaml'),
      'Spec',
      SPEC_OPAQUE_PATHS,
    );
    const session = await loadYamlMapping<Session>(
      path.posix.join(baseDir, 'generated-session.yaml'),
      'Session',
      SESSION_OPAQUE_PATHS,
    );
    const recordings = await loadYamlMapping<Recordings>(
      path.posix.join(baseDir, 'generated-recordings.yaml'),
      'Recording',
      RECORDINGS_OPAQUE_PATHS,
    );

    // Make test names unique by including relative file path from given root dir
    const normalizedDir = directory.replaceAll('\\', '/');
    const relativePath = path.posix.relative(normalizedDir, baseDir);
    const parsedPath = path.posix.parse(relativePath);
    const name = path.posix.join(parsedPath.dir, parsedPath.name);

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
