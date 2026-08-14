/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  Event,
  InMemorySessionService,
  Runner,
  StreamingMode,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {RecordingPlugin} from '../integration/recording_plugin.js';
import {TestSpec, UserMessage} from '../integration/test_types.js';
import {generatedFileNames, writeGeneratedYaml} from './generated_files.js';
import {buildAgentRegistry} from './yaml_agent_loader.js';
import {loadTestSpec, streamSpecFiles} from './yaml_test_loader.js';

/**
 * The session identity a recorded golden carries. It matches the identity
 * `TestRunner` replays under, so re-recording a golden changes only the parts
 * the agent's behaviour changed.
 */
const APP_NAME = 'test-runner';
const USER_ID = 'test-user';
const SESSION_ID = 'test-session';

/**
 * Records the conformance goldens of every test case under `testsDir`.
 *
 * A directory holding a `spec.yaml` is a test case. Each one is recorded on
 * its own: a case whose spec does not load, whose agent is unknown, or whose
 * run throws is reported and the next case still runs.
 *
 * This calls the real model named in the agent config. It needs credentials
 * and it costs money.
 */
export async function recordConformanceTests({
  agentsDir,
  testsDir,
  streamingMode,
}: {
  agentsDir: string;
  testsDir: string;
  streamingMode: StreamingMode;
}): Promise<void> {
  // Reject an unsupported streaming mode before doing any work.
  generatedFileNames(streamingMode);

  const agentRegistry = await buildAgentRegistry(agentsDir);

  console.log(`Loading test specs from ${testsDir}`);
  const specs = await loadTestSpecs(testsDir);
  console.log(specs.size, 'test specs found.');

  const recorded: string[] = [];
  const failed: string[] = [];

  for (const [testCaseDir, spec] of specs) {
    console.log('\x1b[33mRecording', testCaseDir, '\x1b[0m\n');
    try {
      const agent = agentRegistry.getRootAgentByShortName(spec.agent);
      if (!agent) {
        throw new Error(`Agent ${spec.agent} not found in registry`);
      }
      await recordTestCase({agent, spec, testCaseDir, streamingMode});
      recorded.push(testCaseDir);
      console.log('\n\x1b[32mRecorded.\x1b[0m\n');
    } catch (error: unknown) {
      failed.push(testCaseDir);
      console.error(
        `\n\x1b[31mFailed to record ${testCaseDir}: ${errorMessage(error)}\x1b[0m\n`,
      );
    }
  }

  console.log(
    `\n\n${recorded.length} test cases recorded, ${failed.length} failed.`,
  );
  console.log('Recorded:', recorded.join(', '));
  console.log('Failed:', failed.join(', '));
  console.log('\n');
}

/**
 * Records the goldens of one test case and returns the files it wrote.
 *
 * Takes a built agent rather than an agents directory so a caller can record
 * against an agent it holds already.
 */
export async function recordTestCase({
  agent,
  spec,
  testCaseDir,
  streamingMode,
}: {
  agent: BaseAgent;
  spec: TestSpec;
  testCaseDir: string;
  streamingMode: StreamingMode;
}): Promise<{sessionFile: string; recordingsFile: string}> {
  const names = generatedFileNames(streamingMode);
  const sessionFile = path.join(testCaseDir, names.sessionFile);
  const recordingsFile = path.join(testCaseDir, names.recordingsFile);

  // Remove the previous goldens first, so a run that throws cannot leave a
  // stale file that looks like it belongs to the new recording.
  await fs.rm(sessionFile, {force: true});
  await fs.rm(recordingsFile, {force: true});

  const turn = {userMessageIndex: 0};
  const recordingPlugin = new RecordingPlugin(turn);
  const sessionService = new InMemorySessionService();
  const runner = new Runner({
    agent,
    sessionService,
    plugins: [recordingPlugin],
    appName: APP_NAME,
  });

  await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });

  const userMessages = spec.userMessages ?? [];
  const functionCallIds = new Map<string, string>();

  for (let i = 0; i < userMessages.length; i++) {
    turn.userMessageIndex = i;
    const events = runner.runAsync({
      userId: USER_ID,
      sessionId: SESSION_ID,
      newMessage: userMessageToContent(userMessages[i], i, functionCallIds),
      // `TestRunner` seeds the initial state this way, and the replay has to
      // produce the same events as the recording it is compared against.
      stateDelta: i === 0 ? spec.initialState : undefined,
      runConfig: {streamingMode},
    });

    for await (const event of events) {
      rememberFunctionCallIds(event, functionCallIds);
    }
  }

  const session = await sessionService.getSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  if (!session) {
    throw new Error('Session not found after recording');
  }

  await writeGeneratedYaml(sessionFile, session);
  await writeGeneratedYaml(recordingsFile, {
    recordings: recordingPlugin.recordings,
  });

  return {sessionFile, recordingsFile};
}

/**
 * Loads the spec of every test case under `testsDir`, keyed by test case
 * directory.
 *
 * `batchLoadYamlTestDefs` cannot serve this: it also reads the generated files
 * that this command is about to write, which a new test case does not have
 * yet.
 */
async function loadTestSpecs(testsDir: string): Promise<Map<string, TestSpec>> {
  const specs = new Map<string, TestSpec>();

  for await (const specFile of streamSpecFiles(testsDir)) {
    try {
      specs.set(path.posix.dirname(specFile), await loadTestSpec(specFile));
      console.log('loaded test spec from', specFile);
    } catch (error: unknown) {
      console.error(`Failed to load ${specFile}: ${errorMessage(error)}`);
    }
  }

  return specs;
}

function userMessageToContent(
  message: UserMessage,
  index: number,
  functionCallIds: ReadonlyMap<string, string>,
): Content {
  if (message.content) {
    return {
      ...message.content,
      role: 'user',
      parts: message.content.parts?.map((part) =>
        withAnsweredFunctionCallId(part, functionCallIds),
      ),
    };
  }
  if (message.text) {
    return {role: 'user', parts: [{text: message.text}]};
  }

  throw new Error(`UserMessage at index ${index} has neither text nor content`);
}

/**
 * Gives a function response the id of the function call it answers.
 *
 * A spec is written before the run, so it cannot know the id the model assigns
 * to a call. A long-running tool case answers a call from an earlier turn, and
 * the response only reaches that call when the two ids match.
 */
function withAnsweredFunctionCallId(
  part: Part,
  functionCallIds: ReadonlyMap<string, string>,
): Part {
  const name = part.functionResponse?.name;
  if (!name) {
    return part;
  }

  const id = functionCallIds.get(name);
  if (!id) {
    throw new Error(
      `Function response for ${name} does not match any pending function call.`,
    );
  }
  return {...part, functionResponse: {...part.functionResponse, id}};
}

function rememberFunctionCallIds(
  event: Event,
  functionCallIds: Map<string, string>,
): void {
  for (const part of event.content?.parts ?? []) {
    const functionCall = part.functionCall;
    if (functionCall?.name && functionCall.id) {
      functionCallIds.set(functionCall.name, functionCall.id);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
