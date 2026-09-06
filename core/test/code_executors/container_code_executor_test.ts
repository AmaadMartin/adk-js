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
import Dockerode from 'dockerode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  PYTHON_TIMEOUT_WRAPPER,
  TIMEOUT_EXIT_CODE,
} from '../../src/code_executors/python_timeout_wrapper.js';
import {
  FakeContainer,
  createFakeDocker,
  runExitSignalHandler,
} from './docker_test_utils.js';

// The executor imports dockerode dynamically, so the real client is never
// constructed and no Docker daemon is contacted.
vi.mock('dockerode', () => ({default: vi.fn()}));

function createInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.5-flash'}),
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
  });
}

function makeParams(
  code: string,
  language: CodeExecutionLanguage = CodeExecutionLanguage.PYTHON,
): ExecuteCodeParams {
  return {
    invocationContext: createInvocationContext(),
    codeExecutionInput: {code, language, inputFiles: []},
  };
}

/** The `Cmd` of the exec that ran the user code, after the python3 probe. */
function codeCommand(container: FakeContainer): string[] {
  const {Cmd} = container.exec.mock.calls[1][0];
  if (!Cmd) {
    expect.fail('the exec that runs the user code was given no command');
  }
  return Cmd;
}

describe('ContainerCodeExecutor', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.mocked(Dockerode).mockReset();
  });

  afterEach(() => {
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop()!, {recursive: true, force: true});
    }
    vi.restoreAllMocks();
  });

  function createDockerContext(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-container-test-'));
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    tempDirs.push(dir);
    return dir;
  }

  describe('construction', () => {
    it('throws when neither image nor dockerPath is set', () => {
      expect(() => new ContainerCodeExecutor()).toThrow(
        'Either image or dockerPath must be set for ContainerCodeExecutor.',
      );
    });

    it.each([0, -1, 1.5, NaN])(
      'rejects a timeout of %s',
      (timeoutSeconds: number) => {
        expect(
          () =>
            new ContainerCodeExecutor({image: 'test-image', timeoutSeconds}),
        ).toThrow('timeoutSeconds must be a positive integer.');
      },
    );

    it('is never stateful and never optimizes data files', () => {
      const {docker} = createFakeDocker();
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});

      expect(executor.stateful).toBe(false);
      expect(executor.optimizeDataFile).toBe(false);
    });
  });

  describe('container hardening', () => {
    it('disables networking and drops privileges by default', async () => {
      const {docker} = createFakeDocker();
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});

      await executor.executeCode(makeParams('x = 1'));

      expect(docker.createContainer).toHaveBeenCalledWith({
        Image: 'test-image',
        Tty: true,
        NetworkDisabled: true,
        HostConfig: {CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges']},
      });
      await executor.close();
    });

    it('leaves networking on when the caller opts in, still dropping privileges', async () => {
      const {docker} = createFakeDocker();
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        networkEnabled: true,
        docker,
      });

      await executor.executeCode(makeParams('x = 1'));

      expect(docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          NetworkDisabled: false,
          HostConfig: {CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges']},
        }),
      );
      await executor.close();
    });
  });

  describe('executeCode', () => {
    it('bounds the run by the default timeout', async () => {
      const {docker, container} = createFakeDocker();
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});

      await executor.executeCode(makeParams('x = 1'));

      expect(codeCommand(container)).toEqual([
        'python3',
        '-c',
        PYTHON_TIMEOUT_WRAPPER,
        '300',
        'python3',
        '-c',
        'x = 1',
      ]);
      await executor.close();
    });

    it('bounds the run by the configured timeout', async () => {
      const {docker, container} = createFakeDocker();
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        timeoutSeconds: 7,
        docker,
      });

      await executor.executeCode(makeParams('while True: pass'));

      expect(codeCommand(container).slice(0, 4)).toEqual([
        'python3',
        '-c',
        PYTHON_TIMEOUT_WRAPPER,
        '7',
      ]);
      await executor.close();
    });

    it.each([
      [
        CodeExecutionLanguage.JAVASCRIPT,
        'console.log(1)',
        ['node', '-e', 'console.log(1)'],
      ],
      [
        CodeExecutionLanguage.TYPESCRIPT,
        'const x: number = 1;',
        ['npx', '--yes', 'tsx', '--eval', 'const x: number = 1;'],
      ],
      [CodeExecutionLanguage.SHELL, 'echo hi', ['sh', '-c', 'echo hi']],
    ])(
      'runs %s under its own interpreter, still under the supervisor',
      async (
        language: CodeExecutionLanguage,
        code: string,
        interpreter: string[],
      ) => {
        const {docker, container} = createFakeDocker();
        const executor = new ContainerCodeExecutor({
          image: 'test-image',
          docker,
        });

        await executor.executeCode(makeParams(code, language));

        expect(codeCommand(container)).toEqual([
          'python3',
          '-c',
          PYTHON_TIMEOUT_WRAPPER,
          '300',
          ...interpreter,
        ]);
        await executor.close();
      },
    );

    it('throws for a language with no interpreter, before any container starts', async () => {
      const {docker} = createFakeDocker();
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});

      await expect(
        executor.executeCode(
          makeParams('Write-Host 1', CodeExecutionLanguage.POWERSHELL),
        ),
      ).rejects.toThrow(
        'Unsupported language for ContainerCodeExecutor: powershell. ' +
          'Supported: python, javascript, typescript, shell.',
      );
      expect(docker.createContainer).not.toHaveBeenCalled();
    });

    it('splits the exec output into stdout and stderr', async () => {
      const {docker} = createFakeDocker({
        stdout: 'hello\n',
        stderr: 'a warning\n',
      });
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});

      const result = await executor.executeCode(makeParams('print("hello")'));

      expect(result.stdout).toBe('hello\n');
      expect(result.stderr).toBe('a warning\n');
      expect(result.outputFiles).toEqual([]);
      await executor.close();
    });

    it.each([0, 1, 42])(
      'reports the exit status %s the container returned',
      async (exitCode: number) => {
        const {docker} = createFakeDocker({exitCode});
        const executor = new ContainerCodeExecutor({
          image: 'test-image',
          docker,
        });

        const result = await executor.executeCode(makeParams('print(1)'));

        expect(result.exitCode).toBe(exitCode);
        await executor.close();
      },
    );

    it('passes through an exit status Docker did not report', async () => {
      const {docker} = createFakeDocker({exitCode: null});
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});

      const result = await executor.executeCode(makeParams('print(1)'));

      expect(result.exitCode).toBeNull();
      expect(result.stderr).toBe('');
      await executor.close();
    });

    it('reports a run the supervisor cut short', async () => {
      const {docker} = createFakeDocker({exitCode: TIMEOUT_EXIT_CODE});
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        timeoutSeconds: 7,
        docker,
      });

      const result = await executor.executeCode(makeParams('while True: pass'));

      expect(result.stderr).toBe('Code execution timed out after 7 seconds.');
      expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
      await executor.close();
    });

    it('keeps what the code wrote alongside the timeout notice', async () => {
      const {docker} = createFakeDocker({
        stderr: 'a warning from the code',
        exitCode: TIMEOUT_EXIT_CODE,
      });
      const executor = new ContainerCodeExecutor({
        image: 'test-image',
        timeoutSeconds: 7,
        docker,
      });

      const result = await executor.executeCode(makeParams('while True: pass'));

      expect(result.stderr).toBe(
        'a warning from the code\nCode execution timed out after 7 seconds.',
      );
      await executor.close();
    });

    it('leaves stderr alone when the code failed without timing out', async () => {
      const {docker} = createFakeDocker({
        stderr: 'Traceback: boom',
        exitCode: 1,
      });
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});

      const result = await executor.executeCode(
        makeParams('raise Exception()'),
      );

      expect(result.stderr).toBe('Traceback: boom');
      await executor.close();
    });
  });

  describe('container initialization', () => {
    it('builds the image from dockerPath and defaults the tag', async () => {
      const {docker} = createFakeDocker();
      const dockerPath = createDockerContext();
      const executor = new ContainerCodeExecutor({dockerPath, docker});

      await executor.executeCode(makeParams('x = 1'));

      expect(docker.buildImage).toHaveBeenCalledWith(
        {context: path.resolve(dockerPath), src: ['Dockerfile']},
        {t: 'adk-code-executor:latest'},
      );
      expect(docker.buildImage.mock.invocationCallOrder[0]).toBeLessThan(
        docker.createContainer.mock.invocationCallOrder[0],
      );
      await executor.close();
    });

    it('throws when the dockerPath does not exist', async () => {
      const {docker} = createFakeDocker();
      const missing = path.join(os.tmpdir(), 'adk-container-test-absent');
      const executor = new ContainerCodeExecutor({dockerPath: missing, docker});

      await expect(executor.executeCode(makeParams('x = 1'))).rejects.toThrow(
        `Invalid Docker path: ${path.resolve(missing)}`,
      );
    });

    it('surfaces an image build failure unchanged', async () => {
      const {docker} = createFakeDocker({
        buildError: new Error('build failed'),
      });
      const executor = new ContainerCodeExecutor({
        dockerPath: createDockerContext(),
        docker,
      });

      await expect(executor.executeCode(makeParams('x = 1'))).rejects.toThrow(
        'build failed',
      );
    });

    it.each([1, null])(
      'throws when the python3 probe returns %s',
      async (probeExitCode: number | null) => {
        const {docker} = createFakeDocker({probeExitCode});
        const executor = new ContainerCodeExecutor({
          image: 'test-image',
          docker,
        });

        await expect(executor.executeCode(makeParams('x = 1'))).rejects.toThrow(
          'python3 is not installed in the container.',
        );
        await executor.close();
      },
    );

    it('starts one container for two sequential executions', async () => {
      const {docker, container} = createFakeDocker();
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});

      await executor.executeCode(makeParams('x = 1'));
      await executor.executeCode(makeParams('x = 2'));

      expect(docker.createContainer).toHaveBeenCalledTimes(1);
      // One probe plus one exec per execution.
      expect(container.exec).toHaveBeenCalledTimes(3);
      await executor.close();
    });

    it('starts one container for two concurrent executions', async () => {
      const {docker} = createFakeDocker();
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});

      await Promise.all([
        executor.executeCode(makeParams('x = 1')),
        executor.executeCode(makeParams('x = 2')),
      ]);

      expect(docker.createContainer).toHaveBeenCalledTimes(1);
      await executor.close();
    });
  });

  describe('close', () => {
    it('stops and removes the container', async () => {
      const {docker, container} = createFakeDocker();
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});
      await executor.executeCode(makeParams('x = 1'));

      await executor.close();

      expect(container.stop).toHaveBeenCalledTimes(1);
      expect(container.remove).toHaveBeenCalledTimes(1);
      expect(container.stop.mock.invocationCallOrder[0]).toBeLessThan(
        container.remove.mock.invocationCallOrder[0],
      );
    });

    it('does nothing on a second call', async () => {
      const {docker, container} = createFakeDocker();
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});
      await executor.executeCode(makeParams('x = 1'));

      await executor.close();
      await executor.close();

      expect(container.stop).toHaveBeenCalledTimes(1);
      expect(container.remove).toHaveBeenCalledTimes(1);
    });

    it('does nothing when no container was started', async () => {
      const {docker, container} = createFakeDocker();
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});

      await executor.close();

      expect(docker.createContainer).not.toHaveBeenCalled();
      expect(container.stop).not.toHaveBeenCalled();
    });

    it('stops a container whose start was still in flight', async () => {
      const {docker, container} = createFakeDocker();
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      container.start.mockImplementationOnce(() => gate);
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});

      const running = executor.executeCode(makeParams('x = 1'));
      const closing = executor.close();
      release();
      await running;
      await closing;

      expect(container.stop).toHaveBeenCalledTimes(1);
      expect(container.remove).toHaveBeenCalledTimes(1);
    });

    it('recovers from a failed start once the executor is closed', async () => {
      const {docker} = createFakeDocker();
      docker.createContainer.mockRejectedValueOnce(new Error('daemon down'));
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});

      await expect(executor.executeCode(makeParams('x = 1'))).rejects.toThrow(
        'daemon down',
      );
      // Without a close the memoized failure replays for every later call.
      await expect(executor.executeCode(makeParams('x = 1'))).rejects.toThrow(
        'daemon down',
      );
      await executor.close();

      const result = await executor.executeCode(makeParams('x = 1'));

      expect(result.exitCode).toBe(0);
      await executor.close();
    });

    it('keeps the container when the stop fails, so a retry cleans it up', async () => {
      const {docker, container} = createFakeDocker({
        stopErrors: [new Error('daemon unreachable')],
      });
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});
      await executor.executeCode(makeParams('x = 1'));

      await expect(executor.close()).rejects.toThrow('daemon unreachable');
      expect(container.remove).not.toHaveBeenCalled();

      await executor.close();

      expect(container.stop).toHaveBeenCalledTimes(2);
      expect(container.remove).toHaveBeenCalledTimes(1);
    });

    it('starts a fresh container after a successful close', async () => {
      const {docker} = createFakeDocker();
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});

      await executor.executeCode(makeParams('x = 1'));
      await executor.close();
      await executor.executeCode(makeParams('x = 2'));

      expect(docker.createContainer).toHaveBeenCalledTimes(2);
      await executor.close();
    });
  });

  describe('lazy client construction', () => {
    it('builds a default client when none is injected', async () => {
      const {docker} = createFakeDocker();
      vi.mocked(Dockerode).mockReturnValue(docker);
      const executor = new ContainerCodeExecutor({image: 'test-image'});

      await executor.executeCode(makeParams('x = 1'));

      expect(Dockerode).toHaveBeenCalledWith(undefined);
      await executor.close();
    });

    it.each([
      ['unix:///var/run/docker.sock', {socketPath: '/var/run/docker.sock'}],
      [
        'tcp://127.0.0.1:2375',
        {host: '127.0.0.1', port: '2375', protocol: 'http'},
      ],
      [
        'https://127.0.0.1:2376',
        {host: '127.0.0.1', port: '2376', protocol: 'https'},
      ],
      [
        'ssh://user@127.0.0.1',
        {host: '127.0.0.1', port: undefined, protocol: 'ssh'},
      ],
    ])(
      'maps the base url %s onto dockerode options',
      async (baseUrl: string, expected: object) => {
        const {docker} = createFakeDocker();
        vi.mocked(Dockerode).mockReturnValue(docker);
        const executor = new ContainerCodeExecutor({
          image: 'test-image',
          baseUrl,
        });

        await executor.executeCode(makeParams('x = 1'));

        expect(Dockerode).toHaveBeenCalledWith(expected);
        await executor.close();
      },
    );
  });

  describe('cleanup on process exit', () => {
    it('stops and removes a container the caller never closed', async () => {
      const {docker, container} = createFakeDocker();
      const executor = new ContainerCodeExecutor({image: 'test-image', docker});
      await executor.executeCode(makeParams('x = 1'));

      await runExitSignalHandler();

      expect(container.stop).toHaveBeenCalledTimes(1);
      expect(container.remove).toHaveBeenCalledTimes(1);
      // The container is untracked, so a later exit does not stop it twice.
      await runExitSignalHandler();
      expect(container.stop).toHaveBeenCalledTimes(1);
    });
  });
});
