/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {
  createDeploymentManifest,
  DeploymentManifestOptions,
  deployToGke,
  DeployToGkeOptions,
  parseGkeServiceType,
} from '../../src/cli/deploy/cli_deploy_gke.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';
import {
  createTempDir,
  isFile,
  isFolderExists,
  loadFileData,
  saveToFile,
  tryToFindFileRecursively,
} from '../../src/utils/file_utils.js';

type Callback = (error: Error | null, result?: unknown) => void;

const execMock = vi.fn();
const spawnMock =
  vi.fn<(cmd: string, args: string[], opts: unknown) => unknown>();

vi.mock('node:child_process', () => ({
  exec: (cmd: string, callback: Callback) => execMock(cmd, callback),
  spawn: (cmd: string, args: string[], opts: unknown) =>
    spawnMock(cmd, args, opts),
}));

vi.mock('node:fs/promises', () => {
  const mockFs = {
    cp: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
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
  createTempDir: vi.fn(),
  isFile: vi.fn(),
  isFolderExists: vi.fn(),
  loadFileData: vi.fn(),
  saveToFile: vi.fn(),
  tryToFindFileRecursively: vi.fn(),
}));

/**
 * Parsed shape of the generated manifest, as `yaml.loadAll` returns it.
 *
 * `spec` merges the Deployment and Service arms, so the fields specific to
 * either are optional.
 */
interface ManifestDocument {
  apiVersion: string;
  kind: string;
  metadata: {name: string; labels?: Record<string, string>};
  spec: {
    replicas?: number;
    selector?: {app?: string; matchLabels?: {app: string}};
    template?: {
      metadata: {labels: Record<string, string>};
      spec: {
        containers: Array<{
          name: string;
          image: string;
          ports: Array<{containerPort: number}>;
        }>;
      };
    };
    type?: string;
    ports?: Array<{port: number; targetPort: number}>;
  };
}

function loadManifest(manifest: string): ManifestDocument[] {
  return yaml.loadAll(manifest) as ManifestDocument[];
}

describe('parseGkeServiceType', () => {
  it('accepts the supported service types', () => {
    expect(parseGkeServiceType('ClusterIP')).toBe('ClusterIP');
    expect(parseGkeServiceType('LoadBalancer')).toBe('LoadBalancer');
  });

  it('rejects an unsupported service type', () => {
    expect(() => parseGkeServiceType('NodePort')).toThrow(
      /Invalid service type "NodePort"/,
    );
  });
});

describe('createDeploymentManifest', () => {
  const defaultOptions: DeploymentManifestOptions = {
    serviceName: 'my-agent',
    image: 'gcr.io/test-project/my-agent',
    port: 8000,
    adkVersion: 'latest',
    serviceType: 'ClusterIP',
  };

  it('emits a Deployment document followed by a Service document', () => {
    const documents = loadManifest(createDeploymentManifest(defaultOptions));

    expect(documents).toHaveLength(2);
    expect(documents.map((document) => document.kind)).toEqual([
      'Deployment',
      'Service',
    ]);
  });

  it('matches the adk-python Deployment field by field', () => {
    const [deployment] = loadManifest(createDeploymentManifest(defaultOptions));

    expect(deployment).toEqual({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'my-agent',
        labels: {
          'app.kubernetes.io/name': 'adk-agent',
          'app.kubernetes.io/version': 'latest',
          'app.kubernetes.io/instance': 'my-agent',
          'app.kubernetes.io/managed-by': 'adk-cli',
        },
      },
      spec: {
        replicas: 1,
        selector: {matchLabels: {app: 'my-agent'}},
        template: {
          metadata: {
            labels: {
              app: 'my-agent',
              'app.kubernetes.io/name': 'adk-agent',
              'app.kubernetes.io/version': 'latest',
              'app.kubernetes.io/instance': 'my-agent',
              'app.kubernetes.io/managed-by': 'adk-cli',
            },
          },
          spec: {
            containers: [
              {
                name: 'my-agent',
                image: 'gcr.io/test-project/my-agent',
                ports: [{containerPort: 8000}],
              },
            ],
          },
        },
      },
    });
  });

  it('matches the adk-python Service field by field', () => {
    const [, service] = loadManifest(createDeploymentManifest(defaultOptions));

    expect(service).toEqual({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {name: 'my-agent'},
      spec: {
        type: 'ClusterIP',
        selector: {app: 'my-agent'},
        ports: [{port: 80, targetPort: 8000}],
      },
    });
  });

  it('honours a LoadBalancer service type', () => {
    const [, service] = loadManifest(
      createDeploymentManifest({
        ...defaultOptions,
        serviceType: 'LoadBalancer',
      }),
    );

    expect(service.spec.type).toBe('LoadBalancer');
  });

  it.each([
    ['1.0', '1.0'],
    ['no', 'no'],
  ])(
    'keeps the YAML-significant version %s a string',
    (adkVersion, expected) => {
      const [deployment] = loadManifest(
        createDeploymentManifest({...defaultOptions, adkVersion}),
      );

      const version = deployment.metadata.labels?.['app.kubernetes.io/version'];
      expect(version).toBe(expected);
      expect(typeof version).toBe('string');
    },
  );

  it('keeps an image that looks like a document separator inside its value', () => {
    const image = 'gcr.io/p/a\n---\nkind: Pod\nmetadata:\n  name: pwned';

    const documents = loadManifest(
      createDeploymentManifest({...defaultOptions, image}),
    );

    expect(documents).toHaveLength(2);
    expect(documents[0].spec.template?.spec.containers[0].image).toBe(image);
  });

  it.each([
    ['', /Invalid serviceName ""/],
    ['Upper', /Invalid serviceName "Upper"/],
    ['has space', /Invalid serviceName "has space"/],
    ['-leading', /Invalid serviceName "-leading"/],
    ['evil\nkind: Pod', /Invalid serviceName/],
    ['a'.repeat(64), /Invalid serviceName/],
  ])('rejects the service name %j', (serviceName, expected) => {
    expect(() =>
      createDeploymentManifest({...defaultOptions, serviceName}),
    ).toThrow(expected);
  });

  it('accepts a 63 character service name', () => {
    const serviceName = 'a'.repeat(63);

    const [deployment] = loadManifest(
      createDeploymentManifest({...defaultOptions, serviceName}),
    );

    expect(deployment.metadata.name).toBe(serviceName);
  });

  it.each([
    ['', /Invalid adkVersion ""/],
    ['bad value!', /Invalid adkVersion "bad value!"/],
    ['x\nmetadata:\n  name: pwned', /Invalid adkVersion/],
    ['a'.repeat(64), /Invalid adkVersion/],
  ])('rejects the adk version %j', (adkVersion, expected) => {
    expect(() =>
      createDeploymentManifest({...defaultOptions, adkVersion}),
    ).toThrow(expected);
  });

  it.each([
    [0, /Invalid port 0/],
    [70000, /Invalid port 70000/],
    [Number.NaN, /Invalid port NaN/],
    [8000.5, /Invalid port 8000.5/],
  ])('rejects the port %s', (port, expected) => {
    expect(() => createDeploymentManifest({...defaultOptions, port})).toThrow(
      expected,
    );
  });
});

describe('deployToGke', () => {
  const TEMP_FOLDER = '/tmp/test-deploy';
  const defaultOptions: DeployToGkeOptions = {
    agentPath: 'path/to/agent',
    clusterName: 'test-cluster',
    serviceName: 'test-service',
    serviceType: 'ClusterIP',
    tempFolder: TEMP_FOLDER,
    adkVersion: '1.0.0',
    project: 'test-project',
    region: 'us-central1',
    port: 8080,
    withUi: false,
    logLevel: 'INFO',
  };

  const spawnCalls = () =>
    spawnMock.mock.calls.map(([cmd, args]) => [cmd, ...args].join(' '));

  const savedManifest = () => {
    const call = (saveToFile as Mock).mock.calls.find(([filePath]) =>
      String(filePath).endsWith('deployment.yaml'),
    );
    if (!call) {
      return expect.fail('no deployment.yaml was saved');
    }
    return {path: String(call[0]), documents: loadManifest(String(call[1]))};
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    (isFile as Mock).mockResolvedValue(false);
    (isFolderExists as Mock).mockResolvedValue(false);
    (tryToFindFileRecursively as Mock).mockResolvedValue(
      'path/to/package.json',
    );
    (loadFileData as Mock).mockResolvedValue({
      dependencies: {'@google/adk': '^1.0.0'},
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
      } else if (cmd.includes('config get-value compute/region')) {
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

  it('resolves project and region from gcloud config when the flags are omitted', async () => {
    await deployToGke({...defaultOptions, project: '', region: ''});

    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('config get-value project'),
      expect.any(Function),
    );
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('config get-value compute/region'),
      expect.any(Function),
    );
    expect(spawnCalls()[0]).toContain('gcr.io/gcloud-project/test-service');
    expect(spawnMock.mock.calls[1][1]).toEqual(
      expect.arrayContaining([
        '--region',
        'gcloud-region',
        '--project',
        'gcloud-project',
      ]),
    );
  });

  it('throws when the gcloud project is unset', async () => {
    execMock.mockImplementation((cmd: string, callback: Callback) => {
      callback(null, {stdout: '(unset)\n'});
    });

    await expect(deployToGke({...defaultOptions, project: ''})).rejects.toThrow(
      /Project is not specified/,
    );
  });

  it('throws when the gcloud region is unset', async () => {
    execMock.mockImplementation((cmd: string, callback: Callback) => {
      if (cmd.includes('config get-value project')) {
        callback(null, {stdout: 'gcloud-project\n'});
      } else {
        callback(null, {stdout: '(unset)\n'});
      }
    });

    await expect(deployToGke({...defaultOptions, region: ''})).rejects.toThrow(
      /Region is not specified/,
    );
  });

  it('throws when the region resolves to an empty string', async () => {
    execMock.mockImplementation((cmd: string, callback: Callback) => {
      if (cmd.includes('config get-value project')) {
        callback(null, {stdout: 'gcloud-project\n'});
      } else {
        callback(null, {stdout: '\n'});
      }
    });

    await expect(deployToGke({...defaultOptions, region: ''})).rejects.toThrow(
      /Region is not specified/,
    );
  });

  it('throws when the cluster name is missing, before touching gcloud', async () => {
    await expect(
      deployToGke({...defaultOptions, clusterName: ''}),
    ).rejects.toThrow(/Cluster name is not specified/);

    expect(execMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('builds the image with Cloud Build using a lowercased log level', async () => {
    await deployToGke(defaultOptions);

    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      'gcloud',
      [
        'builds',
        'submit',
        '--tag',
        'gcr.io/test-project/test-service',
        '--verbosity',
        'info',
        TEMP_FOLDER,
      ],
      expect.any(Object),
    );
  });

  it('fetches cluster credentials for the cluster, region and project', async () => {
    await deployToGke(defaultOptions);

    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'gcloud',
      [
        'container',
        'clusters',
        'get-credentials',
        'test-cluster',
        '--region',
        'us-central1',
        '--project',
        'test-project',
      ],
      expect.any(Object),
    );
  });

  it('applies the manifest only after the build and the credential step', async () => {
    await deployToGke(defaultOptions);

    expect(spawnMock).toHaveBeenNthCalledWith(
      3,
      'kubectl',
      ['apply', '-f', path.join(TEMP_FOLDER, 'deployment.yaml')],
      expect.any(Object),
    );
    expect(spawnCalls()).toEqual([
      expect.stringContaining('gcloud builds submit'),
      expect.stringContaining('gcloud container clusters get-credentials'),
      expect.stringContaining('kubectl apply'),
    ]);
  });

  it('writes the manifest to deployment.yaml in the staging folder', async () => {
    await deployToGke(defaultOptions);

    const {path: manifestPath, documents} = savedManifest();
    expect(manifestPath).toBe(path.join(TEMP_FOLDER, 'deployment.yaml'));
    expect(documents.map((document) => document.kind)).toEqual([
      'Deployment',
      'Service',
    ]);
    expect(documents[0].metadata.labels).toMatchObject({
      'app.kubernetes.io/version': '1.0.0',
    });
  });

  it('forwards the server options to the generated Dockerfile', async () => {
    await deployToGke({
      ...defaultOptions,
      withUi: true,
      otelToCloud: true,
      allowOrigins: 'http://example.com',
      sessionServiceUri: 'memory://',
      artifactServiceUri: 'gs://bucket',
    });

    const call = (saveToFile as Mock).mock.calls.find(([filePath]) =>
      String(filePath).endsWith('Dockerfile'),
    );
    if (!call) {
      return expect.fail('no Dockerfile was saved');
    }
    const dockerfile = String(call[1]);
    expect(dockerfile).toContain('npx adk web');
    expect(dockerfile).toContain('--otel_to_cloud');
    expect(dockerfile).toContain("--log_level='INFO'");
    expect(dockerfile).toContain("--allow_origins='http://example.com'");
    expect(dockerfile).toContain("--session_service_uri='memory://'");
    expect(dockerfile).toContain("--artifact_service_uri='gs://bucket'");
    expect(dockerfile).toContain('agents/agent/');
  });

  it('carries --service_type=LoadBalancer into the applied manifest', async () => {
    await deployToGke({...defaultOptions, serviceType: 'LoadBalancer'});

    const {documents} = savedManifest();
    expect(documents[1].spec.type).toBe('LoadBalancer');
  });

  it('creates a private staging folder when none is supplied', async () => {
    (createTempDir as Mock).mockResolvedValue('/tmp/gke_deploy_src-abc123');

    await deployToGke({...defaultOptions, tempFolder: undefined});

    expect(createTempDir).toHaveBeenCalledWith('gke_deploy_src');
    expect(isFolderExists).not.toHaveBeenCalled();
    expect(spawnMock.mock.calls[0][1]).toContain('/tmp/gke_deploy_src-abc123');
    expect(fs.rm).toHaveBeenCalledTimes(1);
  });

  it('clears a supplied staging folder that already exists', async () => {
    (isFolderExists as Mock).mockResolvedValue(true);

    await deployToGke(defaultOptions);

    expect(fs.rm).toHaveBeenCalledTimes(2);
    expect(fs.rm).toHaveBeenCalledWith(TEMP_FOLDER, {
      recursive: true,
      force: true,
    });
  });

  it('derives the app name from the agent file when one is given', async () => {
    (isFile as Mock).mockResolvedValue(true);

    await deployToGke({...defaultOptions, agentPath: 'path/to/my_agent.ts'});

    const call = (saveToFile as Mock).mock.calls.find(([filePath]) =>
      String(filePath).endsWith('Dockerfile'),
    );
    if (!call) {
      return expect.fail('no Dockerfile was saved');
    }
    expect(String(call[1])).toContain('agents/my_agent/');
  });

  it('honours an explicit app name', async () => {
    await deployToGke({...defaultOptions, appName: 'custom-app'});

    const call = (saveToFile as Mock).mock.calls.find(([filePath]) =>
      String(filePath).endsWith('Dockerfile'),
    );
    if (!call) {
      return expect.fail('no Dockerfile was saved');
    }
    expect(String(call[1])).toContain('agents/custom-app/');
  });

  it('prints the port-forward hint only for a cluster-internal service', async () => {
    const infoSpy = vi.spyOn(console, 'info');

    await deployToGke(defaultOptions);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'kubectl port-forward svc/test-service 8080:8080',
      ),
    );

    infoSpy.mockClear();
    await deployToGke({...defaultOptions, serviceType: 'LoadBalancer'});
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('kubectl port-forward'),
    );
  });

  it('rejects when a deploy step exits non-zero', async () => {
    spawnMock.mockReturnValue({
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'close') {
          process.nextTick(() => cb(1));
        }
      }),
    });
    const errorSpy = vi.spyOn(console, 'error');

    await expect(deployToGke(defaultOptions)).rejects.toThrow(
      /Command failed with exit code 1/,
    );

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('\x1b[31mFailed to deploy to GKE:'),
      expect.stringContaining('Command failed with exit code 1'),
      expect.stringContaining('\x1b[0m'),
    );
  });

  it('rejects when the manifest cannot be generated', async () => {
    await expect(
      deployToGke({...defaultOptions, serviceName: 'Bad Name'}),
    ).rejects.toThrow(/Invalid serviceName "Bad Name"/);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('releases the staging folder and the agent loader on the success path', async () => {
    const disposeAll = vi.fn().mockResolvedValue(undefined);
    (AgentLoader as Mock).mockImplementation(() => ({
      listAgents: vi.fn().mockResolvedValue(['agent1']),
      getAgentFile: vi.fn().mockResolvedValue({
        getFilePath: vi.fn().mockReturnValue('path/to/agent1.ts'),
      }),
      disposeAll,
    }));

    await deployToGke(defaultOptions);

    expect(fs.rm).toHaveBeenCalledWith(TEMP_FOLDER, {
      recursive: true,
      force: true,
    });
    expect(disposeAll).toHaveBeenCalled();
  });

  it('releases the staging folder and the agent loader on the failure path', async () => {
    const disposeAll = vi.fn().mockResolvedValue(undefined);
    (AgentLoader as Mock).mockImplementation(() => ({
      listAgents: vi.fn().mockResolvedValue(['agent1']),
      getAgentFile: vi.fn().mockResolvedValue({
        getFilePath: vi.fn().mockReturnValue('path/to/agent1.ts'),
      }),
      disposeAll,
    }));
    spawnMock.mockReturnValue({
      on: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'close') {
          process.nextTick(() => cb(1));
        }
      }),
    });

    await expect(deployToGke(defaultOptions)).rejects.toThrow();

    expect(fs.rm).toHaveBeenCalledWith(TEMP_FOLDER, {
      recursive: true,
      force: true,
    });
    expect(disposeAll).toHaveBeenCalled();
  });
});
