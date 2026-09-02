/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemorySessionService, Runner, StreamingMode} from '@google/adk';
import * as fs from 'node:fs/promises';
import {AgentRegistry} from '../integration/agent_registry.js';
import {RecordingPlugin} from '../integration/recording_plugin.js';
import {
  CONFORMANCE_APP_NAME,
  CONFORMANCE_SESSION_ID,
  CONFORMANCE_USER_ID,
} from '../integration/test_runner.js';
import {TestCaseSpec} from '../integration/test_types.js';
import {
  collectFunctionCallIds,
  resolveFunctionResponseId,
  userMessageToContent,
} from '../integration/user_message_utils.js';
import {errorMessage} from '../utils/error_utils.js';
import {AdkLogger} from '../utils/logger.js';
import {generatedFilePaths} from './generated_file_utils.js';
import {loadAgentRegistry} from './yaml_agent_loader.js';
import {batchLoadTestSpecs} from './yaml_test_loader.js';
import {writeYamlFile} from './yaml_writer.js';

const logger = new AdkLogger({label: 'Conformance', colorize: {all: true}});

/** Options of `adk conformance record`. */
export interface ConformanceRecordOptions {
  /** Directories to search for test cases. */
  testPaths: string[];
  /** Which fixture set to write. */
  streamingMode: StreamingMode;
  /** Directory of the agent definitions the specs name. */
  agentsDir: string;
}

/**
 * Records the fixtures a later `adk conformance test` run replays.
 *
 * Every case runs against the model its agent definition names, so this calls
 * the real model and needs credentials.
 *
 * @throws if any test case fails to record, after every case has been tried.
 */
export async function runConformanceRecord({
  testPaths,
  streamingMode,
  agentsDir,
}: ConformanceRecordOptions): Promise<void> {
  const agentRegistry = await loadAgentRegistry(agentsDir);
  const failures: string[] = [];

  for (const testPath of testPaths) {
    for (const testCase of await batchLoadTestSpecs(testPath)) {
      try {
        await recordTestCase(testCase, agentRegistry, streamingMode);
        logger.info(`Recorded ${testCase.name}`);
      } catch (error: unknown) {
        const reason = errorMessage(error);
        failures.push(`${testCase.name}: ${reason}`);
        logger.error(`Failed to record ${testCase.name}: ${reason}`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Failed to record ${failures.length} test case(s):\n${failures.join('\n')}`,
    );
  }
}

async function recordTestCase(
  testCase: TestCaseSpec,
  agentRegistry: AgentRegistry,
  streamingMode: StreamingMode,
): Promise<void> {
  const {sessionFile, recordingsFile} = generatedFilePaths(
    testCase.dir,
    streamingMode,
  );
  // A stale fixture must not survive a re-record that fails later on.
  await fs.rm(sessionFile, {force: true});
  await fs.rm(recordingsFile, {force: true});

  const agent = agentRegistry.getRootAgentByShortName(testCase.spec.agent);
  if (!agent) {
    throw new Error(`Agent ${testCase.spec.agent} not found in registry`);
  }

  const recorder = new RecordingPlugin();
  const sessionService = new InMemorySessionService();
  const runner = new Runner({
    agent,
    sessionService,
    plugins: [recorder],
    appName: CONFORMANCE_APP_NAME,
  });
  await sessionService.createSession({
    appName: CONFORMANCE_APP_NAME,
    userId: CONFORMANCE_USER_ID,
    sessionId: CONFORMANCE_SESSION_ID,
  });

  const pendingFunctionCallIds = new Map<string, string>();
  const userMessages = testCase.spec.userMessages ?? [];
  for (let i = 0; i < userMessages.length; i++) {
    recorder.userMessageIndex = i;
    const content = userMessageToContent(userMessages[i]);
    resolveFunctionResponseId(content, pendingFunctionCallIds);

    const events = runner.runAsync({
      userId: CONFORMANCE_USER_ID,
      sessionId: CONFORMANCE_SESSION_ID,
      newMessage: content,
      // The replay applies the initial state as the first message's delta, so
      // the recording has to do the same to stay reproducible.
      stateDelta: i === 0 ? testCase.spec.initialState : undefined,
      runConfig: {streamingMode},
    });
    for await (const event of events) {
      collectFunctionCallIds(event, pendingFunctionCallIds);
    }
  }

  const session = await sessionService.getSession({
    appName: CONFORMANCE_APP_NAME,
    userId: CONFORMANCE_USER_ID,
    sessionId: CONFORMANCE_SESSION_ID,
  });
  if (!session) {
    throw new Error(
      `Session ${CONFORMANCE_SESSION_ID} not found after recording ${testCase.name}`,
    );
  }

  await writeYamlFile(recordingsFile, {recordings: recorder.recordings});
  await writeYamlFile(sessionFile, session);
}
