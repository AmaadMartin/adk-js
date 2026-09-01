/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  ContainerCodeExecutor,
  ExecuteCodeParams,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import Docker from 'dockerode';
import {afterEach, describe, expect, it} from 'vitest';

/**
 * Runs the executor against a real Docker daemon. It needs a reachable daemon
 * and an image with `python3`, so it is opt-in and never runs in CI. Enable it
 * with `ADK_RUN_DOCKER_IT=1`, and pick the image with `ADK_DOCKER_IT_IMAGE`.
 *
 * The executor creates a container from an image that is already present, and
 * never pulls one. Run `docker pull python:3-slim` first, or the daemon
 * answers 404 and every case here fails.
 */
const shouldRun = !!process.env.ADK_RUN_DOCKER_IT;
const IMAGE = process.env.ADK_DOCKER_IT_IMAGE || 'python:3-slim';

/** Budget for one run, generous enough for a loaded daemon. */
const RUN_TIMEOUT_MS = 120000;

function makeParams(code: string): ExecuteCodeParams {
  return {
    invocationContext: new InvocationContext({
      invocationId: 'docker-e2e',
      agent: new LlmAgent({
        name: 'docker_e2e_agent',
        model: 'gemini-2.5-flash',
      }),
      session: createSession({
        id: 'docker-e2e-session',
        events: [],
        appName: 'docker-e2e-app',
        userId: 'docker-e2e-user',
      }),
      pluginManager: new PluginManager([]),
    }),
    codeExecutionInput: {
      code,
      language: CodeExecutionLanguage.PYTHON,
      inputFiles: [],
    },
  };
}

describe.skipIf(!shouldRun)('ContainerCodeExecutor against real Docker', () => {
  let executor: ContainerCodeExecutor | undefined;

  afterEach(async () => {
    await executor?.close();
    executor = undefined;
  });

  it(
    'runs python code and captures its output',
    async () => {
      executor = new ContainerCodeExecutor({image: IMAGE});

      const result = await executor.executeCode(makeParams('print(1 + 1)'));

      expect(result.stdout).toBe('2\n');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(result.outputFiles).toEqual([]);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'blocks the cloud metadata endpoint by default',
    async () => {
      executor = new ContainerCodeExecutor({image: IMAGE});

      const result = await executor.executeCode(
        makeParams(
          [
            'import socket',
            'sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
            'sock.settimeout(3)',
            'try:',
            '    sock.connect(("169.254.169.254", 80))',
            '    print("CONNECTED")',
            'except OSError:',
            '    print("BLOCKED")',
          ].join('\n'),
        ),
      );

      expect(result.stdout).toContain('BLOCKED');
      expect(result.stdout).not.toContain('CONNECTED');
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'kills a runaway loop and keeps the container usable',
    async () => {
      executor = new ContainerCodeExecutor({image: IMAGE, timeoutSeconds: 2});

      const timedOut = await executor.executeCode(
        makeParams('while True: pass'),
      );
      const after = await executor.executeCode(
        makeParams('print("still here")'),
      );

      expect(timedOut.exitCode).toBe(124);
      expect(timedOut.stderr).toContain(
        'Code execution timed out after 2 seconds.',
      );
      expect(after.stdout).toBe('still here\n');
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'removes the container on close',
    async () => {
      const docker = new Docker();
      const listIds = async (): Promise<string[]> =>
        (await docker.listContainers()).map((entry) => entry.Id);
      const before = new Set(await listIds());

      const running = new ContainerCodeExecutor({image: IMAGE});
      await running.executeCode(makeParams('print(1)'));
      const started = (await listIds()).filter((id) => !before.has(id));
      expect(started).toHaveLength(1);

      await running.close();

      // Checked by id: the host may be running unrelated containers.
      expect(await listIds()).not.toContain(started[0]);
    },
    RUN_TIMEOUT_MS,
  );
});
