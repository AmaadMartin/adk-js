/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared fixtures for the replay plugin tests. Mirrors the `_SpyTool`,
 * `_recording`, `_write_recordings` and `_make_invocation` helpers in
 * adk-python `tests/unittests/cli/plugins/test_replay_plugin.py`.
 */

import {
  BaseTool,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RunAsyncToolRequest,
} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const NON_STREAMING_FILE = 'generated-recordings.yaml';
export const STREAMING_FILE = 'generated-recordings-sse.yaml';

/** Tool that records the args it was actually executed with. */
export class SpyTool extends BaseTool {
  readonly liveCalls: Array<Record<string, unknown>> = [];

  constructor(
    name = 'roll_die',
    private readonly liveResult: Record<string, unknown> = {result: 'live'},
  ) {
    super({name, description: 'test tool'});
  }

  override async runAsync(
    request: RunAsyncToolRequest,
  ): Promise<Record<string, unknown>> {
    this.liveCalls.push(request.args);
    return this.liveResult;
  }
}

/** One snake_case tool recording, as adk-python writes it. */
export function toolRecordingFixture(options?: {
  agentName?: string;
  userMessageIndex?: number;
  toolName?: string;
  args?: Record<string, unknown>;
  response?: Record<string, unknown>;
  callId?: string;
}): Record<string, unknown> {
  const {
    agentName = 'agent_a',
    userMessageIndex = 0,
    toolName = 'roll_die',
    args = {sides: 6},
    response = {result: 4},
    callId = 'fc-1',
  } = options ?? {};
  return {
    user_message_index: userMessageIndex,
    agent_name: agentName,
    tool_recording: {
      tool_call: {id: callId, name: toolName, args},
      tool_response: {id: callId, name: toolName, response},
    },
  };
}

/** Creates a case directory the caller removes with {@link removeCase}. */
export function createCaseDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'adk-replay-'));
}

export function removeCase(caseDir: string): Promise<void> {
  return fs.rm(caseDir, {recursive: true, force: true});
}

export function writeRecordings(
  caseDir: string,
  recordings: Array<Record<string, unknown>>,
  fileName: string = NON_STREAMING_FILE,
): Promise<void> {
  return fs.writeFile(
    path.join(caseDir, fileName),
    yaml.dump({recordings}, {sortKeys: false}),
    'utf-8',
  );
}

/**
 * Builds one invocation plus a per-agent context sharing its session, so a
 * test can drive two agents through a single invocation.
 */
export function makeInvocation(options?: {
  caseDir?: string;
  userMessageIndex?: number;
  streamingMode?: string;
  agentNames?: string[];
}): {
  invocationContext: InvocationContext;
  contexts: Record<string, Context>;
} {
  const {
    caseDir,
    userMessageIndex = 0,
    streamingMode = 'none',
    agentNames = ['agent_a'],
  } = options ?? {};

  const session = createSession({
    id: 'replay-session',
    appName: 'replay-test',
    userId: 'replay-user',
  });
  if (caseDir !== undefined) {
    session.state['_adk_replay_config'] = {
      dir: caseDir,
      user_message_index: userMessageIndex,
      streaming_mode: streamingMode,
    };
  }

  const invocationId = 'replay-invocation';
  const contextFor = (agentName: string) =>
    new InvocationContext({
      invocationId,
      agent: new LlmAgent({name: agentName}),
      session,
      pluginManager: new PluginManager([]),
    });

  const invocationContext = contextFor(agentNames[0]);
  const contexts: Record<string, Context> = {
    [agentNames[0]]: new Context({invocationContext}),
  };
  for (const agentName of agentNames.slice(1)) {
    contexts[agentName] = new Context({
      invocationContext: contextFor(agentName),
    });
  }
  return {invocationContext, contexts};
}
