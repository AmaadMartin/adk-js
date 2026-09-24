/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// The replay file is a real file on disk here, so the run reads and validates
// it exactly as `adk run --replay` does. Only the agent loader is replaced,
// because the agent is built in process instead of compiled from a file.

import {
  InMemorySessionService,
  node,
  RunnableRoot,
  Workflow,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {runAgent} from '../../src/cli/cli_run.js';
import {createTempDir} from '../../src/utils/file_utils.js';

const loaderState = vi.hoisted(() => ({
  agent: undefined as RunnableRoot | undefined,
}));

vi.mock('../../src/utils/agent_loader.js', () => ({
  AgentFile: class {
    async load(): Promise<RunnableRoot> {
      if (!loaderState.agent) {
        throw new Error('loaderState.agent was not set');
      }
      return loaderState.agent;
    }
    async [Symbol.asyncDispose](): Promise<void> {}
  },
}));

describe('adk run --replay input validation', () => {
  let dir = '';
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    dir = await createTempDir('adk_run_replay_test');
    // A workflow rather than an LlmAgent: it answers a turn without a model,
    // so the replayed run needs no network and no credentials.
    loaderState.agent = new Workflow({
      name: 'replay_agent',
      edges: [['START', node(() => 'done', {name: 'step'})]],
    });
    sessionService = new InMemorySessionService();
  });

  afterEach(async () => {
    await fs.rm(dir, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  async function writeReplayFile(contents: string): Promise<string> {
    const filePath = path.join(dir, 'replay.json');
    await fs.writeFile(filePath, contents, {encoding: 'utf-8'});
    return filePath;
  }

  it('stops the run and names the file and the field', async () => {
    const filePath = await writeReplayFile(
      JSON.stringify({state: {}, query: 'what is the weather?'}),
    );

    await expect(
      runAgent({
        agentPath: path.join(dir, 'agent.ts'),
        inputFile: filePath,
        sessionService,
      }),
    ).rejects.toThrow(`Invalid run input file ${filePath}: queries:`);
  });

  it('replays the queries of a valid file', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const filePath = await writeReplayFile(
      JSON.stringify({state: {city: 'Paris'}, queries: ['hello there']}),
    );

    await runAgent({
      agentPath: path.join(dir, 'agent.ts'),
      inputFile: filePath,
      sessionService,
    });

    const printed = vi
      .mocked(console.log)
      .mock.calls.map((call) => call.join(' '));
    expect(printed).toContain('[user]: hello there');
    // listSessions omits state, so the created sessions are read back by id.
    const {sessions} = await sessionService.listSessions({
      appName: 'replay_agent',
      userId: 'test_user',
    });
    const states = await Promise.all(
      sessions.map(async (listed) => {
        const session = await sessionService.getSession({
          appName: 'replay_agent',
          userId: 'test_user',
          sessionId: listed.id,
        });
        return session?.state;
      }),
    );
    expect(states).toContainEqual(
      expect.objectContaining({city: 'Paris', _time: expect.any(String)}),
    );
  });
});
