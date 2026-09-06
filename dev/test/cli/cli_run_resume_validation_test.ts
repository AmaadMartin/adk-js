/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// The saved session is a real file on disk here, so the run reads and
// validates it exactly as `adk run --resume` does. The agent loader is
// replaced because the agent is built in process, and readline is replaced
// because the prompt after the replay needs an answer.

import {
  InMemorySessionService,
  node,
  RunnableRoot,
  Workflow,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';

import {runAgent} from '../../src/cli/cli_run.js';
import {createTempDir} from '../../src/utils/file_utils.js';

const loaderState = vi.hoisted(() => ({
  agent: undefined as RunnableRoot | undefined,
}));

vi.mock('../../src/utils/agent_loader.js', () => ({
  AgentFile: class {
    async load(): Promise<RunnableRoot> {
      if (!loaderState.agent) {
        expect.fail('loaderState.agent was not set');
      }
      return loaderState.agent;
    }
    async [Symbol.asyncDispose](): Promise<void> {}
  },
}));

vi.mock('node:readline', () => ({
  createInterface: vi.fn(),
}));

describe('adk run --resume input validation', () => {
  let dir = '';
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    dir = await createTempDir('adk_run_resume_test');
    // A workflow rather than an LlmAgent: it answers a turn without a model,
    // so the resumed run needs no network and no credentials.
    loaderState.agent = new Workflow({
      name: 'resume_agent',
      edges: [['START', node(() => 'done', {name: 'step'})]],
    });
    sessionService = new InMemorySessionService();
    (readline.createInterface as Mock).mockReturnValue({
      question: (_query: string, callback: (answer: string) => void) => {
        callback('exit');
      },
      close: vi.fn(),
    });
  });

  afterEach(async () => {
    await fs.rm(dir, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  async function writeSessionFile(contents: string): Promise<string> {
    const filePath = path.join(dir, 'session.json');
    await fs.writeFile(filePath, contents, {encoding: 'utf-8'});
    return filePath;
  }

  it('stops the run and names the file and the field', async () => {
    const filePath = await writeSessionFile(
      JSON.stringify({id: 'old-session', events: {author: 'user'}}),
    );

    await expect(
      runAgent({
        agentPath: path.join(dir, 'agent.ts'),
        savedSessionFile: filePath,
        sessionService,
      }),
    ).rejects.toThrow(`Invalid saved session file ${filePath}: events:`);
  });

  it('stops the run when the transcript holds a value that is not an event', async () => {
    const filePath = await writeSessionFile(
      JSON.stringify({id: 'old-session', events: ['hi']}),
    );

    await expect(
      runAgent({
        agentPath: path.join(dir, 'agent.ts'),
        savedSessionFile: filePath,
        sessionService,
      }),
    ).rejects.toThrow(
      `Invalid saved session file ${filePath}: events.0: expected an event object`,
    );
  });

  it('replays the transcript of a valid file', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const filePath = await writeSessionFile(
      JSON.stringify({
        id: 'old-session',
        appName: 'resume_agent',
        userId: 'test_user',
        events: [{author: 'user', content: {parts: [{text: 'hello again'}]}}],
      }),
    );

    await runAgent({
      agentPath: path.join(dir, 'agent.ts'),
      savedSessionFile: filePath,
      sessionService,
    });

    const printed = vi
      .mocked(console.log)
      .mock.calls.map((call) => call.join(' '));
    expect(printed).toContain('[user]: hello again');
  });

  it('carries the saved state into the resumed session', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const filePath = await writeSessionFile(
      JSON.stringify({
        id: 'old-session',
        appName: 'resume_agent',
        userId: 'test_user',
        state: {city: 'Paris'},
        events: [],
      }),
    );

    await runAgent({
      agentPath: path.join(dir, 'agent.ts'),
      savedSessionFile: filePath,
      sessionService,
    });

    // listSessions omits state, so the created sessions are read back by id.
    const {sessions} = await sessionService.listSessions({
      appName: 'resume_agent',
      userId: 'test_user',
    });
    const states = await Promise.all(
      sessions.map(async (listed) => {
        const session = await sessionService.getSession({
          appName: 'resume_agent',
          userId: 'test_user',
          sessionId: listed.id,
        });
        return session?.state;
      }),
    );
    expect(states).toContainEqual({city: 'Paris'});
  });

  it('resumes a session document that carries no transcript', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const filePath = await writeSessionFile(
      JSON.stringify({id: 'old-session', appName: 'resume_agent'}),
    );

    await runAgent({
      agentPath: path.join(dir, 'agent.ts'),
      savedSessionFile: filePath,
      sessionService,
    });

    expect(readline.createInterface).toHaveBeenCalled();
  });
});
