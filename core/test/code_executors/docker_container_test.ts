/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import Dockerode from 'dockerode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {DockerContainer} from '../../src/code_executors/docker_container.js';
import {logger} from '../../src/utils/logger.js';
import {loadOptionalPeer} from '../../src/utils/optional_peer.js';
import {
  ExitSignal,
  createFakeDocker,
  getExitSignalHandler,
  runExitSignalHandler,
} from './docker_test_utils.js';

vi.mock('dockerode', () => ({default: vi.fn()}));

// Wrapped rather than replaced: every test but the missing-peer one below
// still runs the real loader.
vi.mock('../../src/utils/optional_peer.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/optional_peer.js')>();
  return {...actual, loadOptionalPeer: vi.fn(actual.loadOptionalPeer)};
});

const {loadOptionalPeer: actualLoadOptionalPeer} = await vi.importActual<
  typeof import('../../src/utils/optional_peer.js')
>('../../src/utils/optional_peer.js');

/** Whether `raw` is the `once` wrapper Node built around `handler`. */
function hasWrappedListener(raw: unknown, handler: unknown): boolean {
  return (
    typeof raw === 'function' && 'listener' in raw && raw.listener === handler
  );
}

describe('DockerContainer', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop()!, {recursive: true, force: true});
    }
    vi.restoreAllMocks();
  });

  function createDockerContext(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-docker-test-'));
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    tempDirs.push(dir);
    return dir;
  }

  function createContainer(
    ...args: Parameters<typeof createFakeDocker>
  ): {subject: DockerContainer} & ReturnType<typeof createFakeDocker> {
    const fake = createFakeDocker(...args);
    return {
      ...fake,
      subject: new DockerContainer({
        image: 'test-image',
        networkEnabled: false,
        docker: fake.docker,
      }),
    };
  }

  describe('start', () => {
    it('refuses a second start, which would orphan the running container', async () => {
      const {subject, docker} = createContainer();
      await subject.start();

      await expect(subject.start()).rejects.toThrow(
        'Container is already started.',
      );
      expect(docker.createContainer).toHaveBeenCalledTimes(1);
      await subject.stop();
    });

    it('starts again after a stop', async () => {
      const {subject, docker} = createContainer();

      await subject.start();
      await subject.stop();
      await subject.start();

      expect(docker.createContainer).toHaveBeenCalledTimes(2);
      await subject.stop();
    });
  });

  describe('execute', () => {
    it('refuses to run a command before the container is started', async () => {
      const {subject} = createContainer();

      await expect(subject.execute(['echo', 'hi'])).rejects.toThrow(
        'Container is not started.',
      );
    });

    it('attaches both output streams and leaves the exec without a TTY', async () => {
      const {subject, container} = createContainer({stdout: 'out'});
      await subject.start();

      const result = await subject.execute(['echo', 'hi']);

      expect(container.exec).toHaveBeenCalledWith({
        Cmd: ['echo', 'hi'],
        AttachStdout: true,
        AttachStderr: true,
      });
      expect(result.stdout).toBe('out');
      await subject.stop();
    });

    it('rejects when the exec output stream fails', async () => {
      const {subject} = createContainer({
        execStreamError: new Error('stream broke'),
      });
      await subject.start();

      await expect(subject.execute(['echo', 'hi'])).rejects.toThrow(
        'stream broke',
      );
      await subject.stop();
    });
  });

  describe('build', () => {
    it('rejects a path that holds no Dockerfile directory', async () => {
      const {subject, docker} = createContainer();
      const missing = path.join(os.tmpdir(), 'adk-docker-test-absent');

      await expect(subject.build(missing)).rejects.toThrow(
        `Invalid Docker path: ${missing}`,
      );
      expect(docker.buildImage).not.toHaveBeenCalled();
    });

    it('surfaces a build failure reported through followProgress', async () => {
      const {subject} = createContainer({
        buildError: new Error('build failed'),
      });

      await expect(subject.build(createDockerContext())).rejects.toThrow(
        'build failed',
      );
    });
  });

  describe('stop', () => {
    it('does nothing when the container was never started', async () => {
      const {subject, container} = createContainer();

      await expect(subject.stop()).resolves.toBeUndefined();
      expect(container.stop).not.toHaveBeenCalled();
    });

    it('leaves a container the daemon refused to stop in the exit cleanup set', async () => {
      const {subject, container} = createContainer({
        stopErrors: [new Error('daemon unreachable')],
      });
      await subject.start();

      await expect(subject.stop()).rejects.toThrow('daemon unreachable');

      await runExitSignalHandler();
      expect(container.stop).toHaveBeenCalledTimes(2);
      expect(container.remove).toHaveBeenCalledTimes(1);
    });
  });

  describe('cleanup on process exit', () => {
    it('logs a container it cannot stop and keeps going', async () => {
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const {subject, container} = createContainer({
        stopErrors: [new Error('boom')],
      });
      await subject.start();

      const kill = await runExitSignalHandler();
      expect(kill).toHaveBeenCalled();

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to stop and remove container on exit'),
      );
      expect(container.remove).not.toHaveBeenCalled();
      await subject.stop();
    });

    it.each<ExitSignal>(['SIGINT', 'SIGTERM'])(
      're-raises %s so the host process still terminates',
      async (signal: ExitSignal) => {
        const {subject, container} = createContainer();
        await subject.start();

        const kill = await runExitSignalHandler(signal);

        // Registering any listener disables Node's default terminate-on-signal
        // behaviour, so the handler has to deliver the signal again itself.
        expect(kill).toHaveBeenCalledWith(process.pid, signal);
        expect(container.stop.mock.invocationCallOrder[0]).toBeLessThan(
          kill.mock.invocationCallOrder[0],
        );
      },
    );

    it.each<ExitSignal>(['SIGINT', 'SIGTERM'])(
      'listens for %s only once, so the re-raise cannot re-enter it',
      async (signal: ExitSignal) => {
        const {subject} = createContainer();
        await subject.start();
        const handler = getExitSignalHandler();

        // Node detaches a `once` listener before running it and returns it
        // wrapped from `rawListeners`. A plain `on` listener would come back
        // unwrapped, and the re-raise would then loop back into the handler.
        const raw = process
          .rawListeners(signal)
          .find((listener) => hasWrappedListener(listener, handler));

        expect(raw).toBeDefined();
        await subject.stop();
      },
    );
  });

  describe('optional peer dependency', () => {
    it('names the executor and the install command when dockerode is absent', async () => {
      // dockerode is installed here, so the import cannot fail on its own.
      // The real loader runs against a thunk that reports the module as
      // missing, which proves both the peer descriptor and the message.
      vi.mocked(loadOptionalPeer).mockImplementationOnce((peer) => {
        expect(peer).toEqual({
          packageName: 'dockerode',
          feature: 'ContainerCodeExecutor',
        });
        return actualLoadOptionalPeer(peer, () => {
          throw Object.assign(new Error("Cannot find package 'dockerode'"), {
            code: 'ERR_MODULE_NOT_FOUND',
          });
        });
      });
      const subject = new DockerContainer({
        image: 'test-image',
        networkEnabled: false,
      });

      await expect(subject.start()).rejects.toThrow(
        /ContainerCodeExecutor requires the optional peer dependency "dockerode"[\s\S]*npm install dockerode/,
      );
    });
  });

  describe('lazy client construction', () => {
    it('reuses one client across the container lifecycle', async () => {
      const {docker} = createFakeDocker();
      // The fake is itself built on a bare instance of the mocked constructor,
      // so only the calls the container makes should be counted.
      vi.mocked(Dockerode).mockClear();
      vi.mocked(Dockerode).mockReturnValue(docker);
      const subject = new DockerContainer({
        image: 'test-image',
        networkEnabled: false,
        baseUrl: 'unix:///var/run/docker.sock',
      });

      await subject.build(createDockerContext());
      await subject.start();
      await subject.execute(['echo', 'hi']);
      await subject.stop();

      expect(Dockerode).toHaveBeenCalledTimes(1);
      expect(Dockerode).toHaveBeenCalledWith({
        socketPath: '/var/run/docker.sock',
      });
    });
  });
});
