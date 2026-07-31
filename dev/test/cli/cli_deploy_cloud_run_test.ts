/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {
  createDockerFileContent,
  CreateDockerFileContentOptions,
  deployToCloudRun,
} from '../../src/cli/deploy/cli_deploy_cloud_run.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';
import {
  isFile,
  isFileExists,
  isFolderExists,
  loadFileData,
  tryToFindFileRecursively,
} from '../../src/utils/file_utils.js';

type Callback = (error: Error | null, result?: unknown) => void;

const execMock = vi.fn();
const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  exec: (cmd: string, callback: Callback) => execMock(cmd, callback),
  spawn: (cmd: string, args: string[], opts: unknown) =>
    spawnMock(cmd, args, opts),
}));

vi.mock('node:fs/promises', () => {
  const mockFs = {
    cp: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    rm: vi.fn().mockResolvedValue(undefined),
  };
  return {
    ...mockFs,
    default: mockFs,
  };
});

vi.mock('../../src/utils/agent_loader.js', () => ({
  AgentLoader: vi.fn().mockImplementation(() => ({
    listAgents: vi.fn().mockResolvedValue(['agent1']),
    getAgentFile: vi.fn().mockResolvedValue({
      getFilePath: vi.fn().mockReturnValue('path/to/agent1.ts'),
    }),
    disposeAll: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../src/utils/file_utils.js', () => ({
  isFile: vi.fn(),
  isFileExists: vi.fn(),
  isFolderExists: vi.fn(),
  loadFileData: vi.fn(),
  saveToFile: vi.fn(),
  tryToFindFileRecursively: vi.fn(),
}));

describe('createDockerFileContent', () => {
  const defaultOptions: CreateDockerFileContentOptions = {
    appName: 'test-app',
    project: 'test-project',
    region: 'us-central1',
    port: 8080,
    withUi: false,
    logLevel: 'info',
  };

  it('should create Dockerfile content without --a2a by default', () => {
    const content = createDockerFileContent(defaultOptions);
    expect(content).not.toContain('--a2a');
  });

  it('should create Dockerfile content with --a2a when option is true', () => {
    const content = createDockerFileContent({
      ...defaultOptions,
      a2a: true,
    });
    expect(content).toContain('--a2a');
  });

  it('should use web command when withUi is true', () => {
    const content = createDockerFileContent({
      ...defaultOptions,
      withUi: true,
    });
    expect(content).toContain('npx adk web');
  });

  it('should use api_server command when withUi is false', () => {
    const content = createDockerFileContent({
      ...defaultOptions,
      withUi: false,
    });
    expect(content).toContain('npx adk api_server');
  });

  it('should include other options in adkServerOptions', () => {
    const content = createDockerFileContent({
      ...defaultOptions,
      allowOrigins: 'http://example.com',
      otelToCloud: true,
    });
    expect(content).toContain('--allow_origins=http://example.com');
    expect(content).toContain('--otel_to_cloud');
  });
});

describe('deployToCloudRun', () => {
  const defaultOptions = {
    agentPath: 'path/to/agent',
    serviceName: 'test-service',
    tempFolder: '/tmp/test-deploy',
    adkVersion: '1.0.0',
    project: 'test-project',
    region: 'us-central1',
    port: 8080,
    withUi: false,
    logLevel: 'info',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Default mock behavior
    (isFile as Mock).mockResolvedValue(false);
    (isFolderExists as Mock).mockResolvedValue(false);
    (tryToFindFileRecursively as Mock).mockResolvedValue(
      'path/to/package.json',
    );
    (loadFileData as Mock).mockResolvedValue({
      dependencies: {
        '@google/adk': '^1.0.0',
      },
    });

    (AgentLoader as Mock).mockImplementation(() => ({
      listAgents: vi.fn().mockResolvedValue(['agent1']),
      getAgentFile: vi.fn().mockResolvedValue({
        getFilePath: vi.fn().mockReturnValue('path/to/agent1.ts'),
      }),
      disposeAll: vi.fn().mockResolvedValue(undefined),
    }));

    execMock.mockImplementation((cmd: string, callback: Callback) => {
      if (cmd.includes('config get-value project')) {
        callback(null, {stdout: 'gcloud-project\n'});
      } else if (cmd.includes('config get-value run/region')) {
        callback(null, {stdout: 'gcloud-region\n'});
      } else {
        callback(null, {stdout: ''});
      }
    });

    spawnMock.mockReturnValue({
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'close') {
          process.nextTick(() => cb(0));
        }
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should deploy successfully with explicit options', async () => {
    await deployToCloudRun(defaultOptions);

    expect(spawnMock).toHaveBeenCalledWith(
      'gcloud',
      expect.arrayContaining([
        'run',
        'deploy',
        'test-service',
        '--project',
        'test-project',
        '--region',
        'us-central1',
      ]),
      expect.any(Object),
    );
    expect(fs.rm).toHaveBeenCalledWith('/tmp/test-deploy', {
      recursive: true,
      force: true,
    });
  });

  it('should resolve default project and region from gcloud if not provided', async () => {
    const optionsWithoutProjectRegion = {
      ...defaultOptions,
      project: '',
      region: '',
    };

    await deployToCloudRun(optionsWithoutProjectRegion);

    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('config get-value project'),
      expect.any(Function),
    );
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('config get-value run/region'),
      expect.any(Function),
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'gcloud',
      expect.arrayContaining([
        '--project',
        'gcloud-project',
        '--region',
        'gcloud-region',
      ]),
      expect.any(Object),
    );
  });

  it('should throw error if project resolution fails (unset)', async () => {
    const optionsWithoutProject = {
      ...defaultOptions,
      project: '',
    };

    execMock.mockImplementation((cmd: string, callback: Callback) => {
      if (cmd.includes('config get-value project')) {
        callback(null, {stdout: '(unset)\n'});
      } else if (cmd.includes('config get-value run/region')) {
        callback(null, {stdout: 'gcloud-region\n'});
      }
    });

    await expect(deployToCloudRun(optionsWithoutProject)).rejects.toThrow(
      /Project is not specified/,
    );
  });

  it('should clean up existing temp folder before deploying', async () => {
    (isFolderExists as Mock).mockResolvedValue(true);

    await deployToCloudRun(defaultOptions);

    expect(fs.rm).toHaveBeenCalledWith('/tmp/test-deploy', {
      recursive: true,
      force: true,
    });
  });

  it('should throw error if package.json has no dependencies', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error');
    (loadFileData as Mock).mockResolvedValue({});

    await deployToCloudRun(defaultOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('\x1b[31mFailed to deploy to Cloud Run:'),
      expect.stringContaining('No dependencies found in package.json'),
      expect.stringContaining('\x1b[0m'),
    );
  });

  it('should throw error if required npm packages are missing in package.json', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error');
    (loadFileData as Mock).mockResolvedValue({
      dependencies: {
        'some-other-package': '1.0.0',
      },
    });

    await deployToCloudRun(defaultOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('\x1b[31mFailed to deploy to Cloud Run:'),
      expect.stringContaining(
        'Package "@google/adk" is required but not found',
      ),
      expect.stringContaining('\x1b[0m'),
    );
  });

  it('should handle spawn failures', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error');
    spawnMock.mockReturnValue({
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'close') {
          process.nextTick(() => cb(1));
        }
      }),
    });

    await deployToCloudRun(defaultOptions);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('\x1b[31mFailed to deploy to Cloud Run:'),
      expect.stringContaining('Command failed with exit code 1'),
      expect.stringContaining('\x1b[0m'),
    );
  });

  describe('.env forwarding', () => {
    /** Makes `path/to/agent/.env` readable with the given contents. */
    function givenEnvFile(contents: string) {
      (isFileExists as Mock).mockResolvedValue(true);
      (fs.readFile as Mock).mockResolvedValue(contents);
    }

    /** The argument list the deploy passed to `gcloud`. */
    function gcloudArgs(): string[] {
      const call = spawnMock.mock.calls.find(
        ([command]) => command === 'gcloud',
      );
      if (!call) {
        expect.fail('gcloud was never spawned');
      }
      const args: unknown = call[1];
      if (!Array.isArray(args)) {
        expect.fail('gcloud was spawned without an argument list');
      }
      return args.map(String);
    }

    /** The value of the single `--update-env-vars` argument. */
    function updateEnvVarsValue(): string | undefined {
      const args = gcloudArgs();
      expect(args.filter((arg) => arg === '--update-env-vars')).toHaveLength(1);
      return args[args.indexOf('--update-env-vars') + 1];
    }

    it('should read the .env next to the agent and forward its variables', async () => {
      givenEnvFile('A=1\nB=2\n');

      await deployToCloudRun(defaultOptions);

      expect(fs.readFile).toHaveBeenCalledWith(
        path.join('path/to/agent', '.env'),
        {encoding: 'utf-8'},
      );
      expect(updateEnvVarsValue()).toBe('A=1,B=2');
    });

    it('should escape the gcloud delimiter when a value contains a comma', async () => {
      givenEnvFile('FEATURE_FLAGS=alpha,beta\n');

      await deployToCloudRun(defaultOptions);

      expect(updateEnvVarsValue()).toBe('^@^FEATURE_FLAGS=alpha,beta');
    });

    it('should use project and region from .env when no flags are passed', async () => {
      givenEnvFile(
        'GOOGLE_CLOUD_PROJECT=env-project\nGOOGLE_CLOUD_LOCATION=env-region\nA=1\n',
      );

      await deployToCloudRun({...defaultOptions, project: '', region: ''});

      const args = gcloudArgs();
      expect(args[args.indexOf('--project') + 1]).toBe('env-project');
      expect(args[args.indexOf('--region') + 1]).toBe('env-region');
      expect(execMock).not.toHaveBeenCalled();
      expect(updateEnvVarsValue()).toBe('A=1');
      expect(console.info).not.toHaveBeenCalledWith(
        '--project option is not provided, using default project from gcloud config:',
        expect.anything(),
      );
      expect(console.info).not.toHaveBeenCalledWith(
        '--region option is not provided, using default region from gcloud config:',
        expect.anything(),
      );
    });

    it('should keep the CLI project and region and warn when .env also sets them', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});
      givenEnvFile(
        'GOOGLE_CLOUD_PROJECT=env-project\nGOOGLE_CLOUD_LOCATION=env-region\n',
      );

      await deployToCloudRun(defaultOptions);

      const args = gcloudArgs();
      expect(args[args.indexOf('--project') + 1]).toBe('test-project');
      expect(args[args.indexOf('--region') + 1]).toBe('us-central1');
      expect(args).not.toContain('--update-env-vars');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Ignoring GOOGLE_CLOUD_PROJECT in .env'),
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Ignoring GOOGLE_CLOUD_LOCATION in .env'),
      );
    });

    it('should reject a passthrough env-var argument that would clobber the .env', async () => {
      givenEnvFile('A=1\n');

      await expect(
        deployToCloudRun({
          ...defaultOptions,
          extraGcloudArgs: ['--set-env-vars=FOO=bar'],
        }),
      ).rejects.toThrow(/conflict with ADK's automatic configuration/);
    });
  });
});
