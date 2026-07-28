/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  GkeCodeExecutor,
  InvocationContext,
} from '@google/adk';
import {logger} from '@google/adk/utils/logger.js';
import {
  ApiException,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
} from '@kubernetes/client-node';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface MockBatchApi {
  createNamespacedJob: ReturnType<typeof vi.fn>;
  readNamespacedJob: ReturnType<typeof vi.fn>;
}

interface MockCoreApi {
  createNamespacedConfigMap: ReturnType<typeof vi.fn>;
  patchNamespacedConfigMap: ReturnType<typeof vi.fn>;
  listNamespacedPod: ReturnType<typeof vi.fn>;
  readNamespacedPodLog: ReturnType<typeof vi.fn>;
}

function makeBatchApi(): MockBatchApi {
  return {
    createNamespacedJob: vi.fn().mockResolvedValue({
      metadata: {name: 'adk-exec-x', uid: 'uid-1'},
      apiVersion: 'batch/v1',
      kind: 'Job',
    }),
    readNamespacedJob: vi.fn().mockResolvedValue({status: {succeeded: 1}}),
  };
}

function makeCoreApi(): MockCoreApi {
  return {
    createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    patchNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    listNamespacedPod: vi
      .fn()
      .mockResolvedValue({items: [{metadata: {name: 'pod-1'}}]}),
    readNamespacedPodLog: vi.fn().mockResolvedValue('hello world'),
  };
}

const INVOCATION_CONTEXT = {
  invocationId: 'test-invocation-123',
} as unknown as InvocationContext;

function executeWith(executor: GkeCodeExecutor, code = 'print("hello world")') {
  return executor.executeCode({
    invocationContext: INVOCATION_CONTEXT,
    codeExecutionInput: {
      code,
      language: CodeExecutionLanguage.PYTHON,
      inputFiles: [],
    },
  });
}

describe('GkeCodeExecutor', () => {
  let batchApi: MockBatchApi;
  let coreApi: MockCoreApi;

  beforeEach(() => {
    batchApi = makeBatchApi();
    coreApi = makeCoreApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function newExecutor(
    overrides: Record<string, unknown> = {},
  ): GkeCodeExecutor {
    return new GkeCodeExecutor({
      batchApi: batchApi as unknown as BatchV1Api,
      coreApi: coreApi as unknown as CoreV1Api,
      ...overrides,
    });
  }

  describe('constructor', () => {
    it('initializes with defaults', () => {
      const executor = newExecutor();
      expect(executor['namespace']).toBe('default');
      expect(executor['image']).toBe('python:3.11-slim');
      expect(executor['timeoutSeconds']).toBe(300);
      expect(executor['cpuRequested']).toBe('200m');
      expect(executor['memRequested']).toBe('256Mi');
      expect(executor['cpuLimit']).toBe('500m');
      expect(executor['memLimit']).toBe('512Mi');
    });

    it('applies overrides for every option', () => {
      const executor = newExecutor({
        namespace: 'test-ns',
        image: 'custom-python:latest',
        timeoutSeconds: 60,
        cpuRequested: '100m',
        memRequested: '128Mi',
        cpuLimit: '1000m',
        memLimit: '256Mi',
      });
      expect(executor['namespace']).toBe('test-ns');
      expect(executor['image']).toBe('custom-python:latest');
      expect(executor['timeoutSeconds']).toBe(60);
      expect(executor['cpuRequested']).toBe('100m');
      expect(executor['memRequested']).toBe('128Mi');
      expect(executor['cpuLimit']).toBe('1000m');
      expect(executor['memLimit']).toBe('256Mi');
    });
  });

  describe('executeCode', () => {
    it('returns pod logs as stdout on success', async () => {
      const result = await executeWith(newExecutor());

      expect(result.stdout).toBe('hello world');
      expect(result.stderr).toBe('');
      expect(result.outputFiles).toEqual([]);
      expect(coreApi.createNamespacedConfigMap).toHaveBeenCalledOnce();
      expect(batchApi.createNamespacedJob).toHaveBeenCalledOnce();
      expect(coreApi.patchNamespacedConfigMap).toHaveBeenCalledOnce();
      expect(coreApi.readNamespacedPodLog).toHaveBeenCalledOnce();
    });

    it('returns stderr when the Job fails', async () => {
      batchApi.readNamespacedJob.mockResolvedValue({status: {failed: 1}});
      coreApi.readNamespacedPodLog.mockResolvedValue(
        'Traceback...\nValueError: failure',
      );

      const result = await executeWith(newExecutor());

      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Job failed. Logs:');
      expect(result.stderr).toContain('ValueError: failure');
    });

    it('returns stderr when the Pod cannot be found', async () => {
      coreApi.listNamespacedPod.mockResolvedValue({items: []});

      const result = await executeWith(newExecutor());

      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('An unexpected executor error occurred');
      expect(result.stderr).toContain('Could not find Pod');
    });

    it('returns stderr for a non-Error thrown value', async () => {
      coreApi.createNamespacedConfigMap.mockRejectedValue('weird failure');

      const result = await executeWith(newExecutor());

      expect(result.stderr).toBe(
        'An unexpected executor error occurred: weird failure',
      );
    });

    it('times out when the Job never completes', async () => {
      batchApi.readNamespacedJob.mockResolvedValue({status: {}});
      coreApi.readNamespacedPodLog.mockResolvedValue('Still running...');
      vi.useFakeTimers();

      const executePromise = executeWith(newExecutor({timeoutSeconds: 2}));

      const [result] = await Promise.all([
        executePromise,
        vi.runAllTimersAsync(),
      ]);

      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Executor timed out');
      expect(result.stderr).toContain('did not complete within 2s');
      expect(result.stderr).toContain('Pod Logs:\nStill running...');
    });
  });

  describe('Kubernetes API error handling', () => {
    it('reports the reason from a JSON error body', async () => {
      coreApi.createNamespacedConfigMap.mockRejectedValue(
        new ApiException(
          500,
          'msg',
          JSON.stringify({reason: 'Test API Error'}),
          {},
        ),
      );

      const result = await executeWith(newExecutor());

      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('Kubernetes API error: Test API Error');
    });

    it('falls back to the message field when reason is absent', async () => {
      coreApi.createNamespacedConfigMap.mockRejectedValue(
        new ApiException(
          500,
          'msg',
          JSON.stringify({message: 'message-only'}),
          {},
        ),
      );

      const result = await executeWith(newExecutor());

      expect(result.stderr).toBe('Kubernetes API error: message-only');
    });

    it('reads reason from an already-parsed object body', async () => {
      coreApi.createNamespacedConfigMap.mockRejectedValue(
        new ApiException(500, 'msg', {reason: 'object reason'}, {}),
      );

      const result = await executeWith(newExecutor());

      expect(result.stderr).toBe('Kubernetes API error: object reason');
    });

    it('falls back to the exception message for a non-JSON body', async () => {
      coreApi.createNamespacedConfigMap.mockRejectedValue(
        new ApiException(500, 'boom', 'not-json-at-all', {}),
      );

      const result = await executeWith(newExecutor());

      expect(result.stderr).toContain('Kubernetes API error:');
      expect(result.stderr).toContain('boom');
    });

    it('falls back to the exception message for a null body', async () => {
      coreApi.createNamespacedConfigMap.mockRejectedValue(
        new ApiException(500, 'null-body', 'null', {}),
      );

      const result = await executeWith(newExecutor());

      expect(result.stderr).toContain('null-body');
    });

    it('reports a generic reason when no message is available', async () => {
      const err = new ApiException(500, '', 'not-json', {});
      err.message = '';
      coreApi.createNamespacedConfigMap.mockRejectedValue(err);

      const result = await executeWith(newExecutor());

      expect(result.stderr).toBe('Kubernetes API error: Unknown error');
    });
  });

  describe('Job manifest', () => {
    it('builds a hardened manifest with all security fields', async () => {
      await executeWith(
        newExecutor({namespace: 'test-ns', image: 'test-img:v1'}),
      );

      const {body: job} = batchApi.createNamespacedJob.mock.calls[0][0];
      expect(job.apiVersion).toBe('batch/v1');
      expect(job.kind).toBe('Job');
      expect(job.metadata.name).toMatch(/^adk-exec-[0-9a-f]{10}$/);
      expect(
        job.metadata.annotations['adk.agent.google.com/invocation-id'],
      ).toBe('test-invocation-123');
      expect(job.spec.backoffLimit).toBe(0);
      expect(job.spec.ttlSecondsAfterFinished).toBe(600);

      const podSpec = job.spec.template.spec;
      expect(podSpec.restartPolicy).toBe('Never');
      expect(podSpec.runtimeClassName).toBe('gvisor');
      expect(podSpec.tolerations).toHaveLength(1);
      expect(podSpec.tolerations[0].value).toBe('gvisor');
      expect(podSpec.volumes).toHaveLength(1);
      expect(podSpec.volumes[0].name).toBe('code-volume');
      expect(podSpec.volumes[0].configMap.name).toMatch(/^code-src-adk-exec-/);

      const container = podSpec.containers[0];
      expect(container.name).toBe('code-runner');
      expect(container.image).toBe('test-img:v1');
      expect(container.command).toEqual(['python3', '/app/code.py']);
      expect(container.volumeMounts[0].mountPath).toBe('/app');
      expect(container.securityContext).toEqual({
        runAsNonRoot: true,
        runAsUser: 1001,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: {drop: ['ALL']},
      });
      expect(container.resources.requests).toEqual({
        cpu: '200m',
        memory: '256Mi',
      });
      expect(container.resources.limits).toEqual({
        cpu: '500m',
        memory: '512Mi',
      });
    });

    it('writes the code into the ConfigMap', async () => {
      await executeWith(newExecutor(), 'print("hi")');

      const {body: configMap} =
        coreApi.createNamespacedConfigMap.mock.calls[0][0];
      expect(configMap.data['code.py']).toBe('print("hi")');
    });
  });

  describe('owner reference', () => {
    it('patches the ConfigMap to be owned by the Job', async () => {
      await executeWith(newExecutor());

      const {body} = coreApi.patchNamespacedConfigMap.mock.calls[0][0];
      const ownerRef = body.metadata.ownerReferences[0];
      expect(ownerRef.uid).toBe('uid-1');
      expect(ownerRef.name).toBe('adk-exec-x');
      expect(ownerRef.controller).toBe(true);
    });

    it('uses fallbacks when the created Job lacks metadata', async () => {
      batchApi.createNamespacedJob.mockResolvedValue({});

      await executeWith(newExecutor());

      const {body} = coreApi.patchNamespacedConfigMap.mock.calls[0][0];
      const ownerRef = body.metadata.ownerReferences[0];
      expect(ownerRef.apiVersion).toBe('batch/v1');
      expect(ownerRef.kind).toBe('Job');
      expect(ownerRef.name).toBe('');
      expect(ownerRef.uid).toBe('');
    });

    it('continues and warns when the owner-reference patch fails', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      coreApi.patchNamespacedConfigMap.mockRejectedValue(
        new ApiException(
          500,
          'msg',
          JSON.stringify({reason: 'patch denied'}),
          {},
        ),
      );

      const result = await executeWith(newExecutor());

      expect(result.stdout).toBe('hello world');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to set ownerReference'),
      );
    });

    it('rethrows non-API errors from the owner-reference patch', async () => {
      coreApi.patchNamespacedConfigMap.mockRejectedValue(
        new Error('unexpected patch error'),
      );

      const result = await executeWith(newExecutor());

      expect(result.stderr).toContain('An unexpected executor error occurred');
      expect(result.stderr).toContain('unexpected patch error');
    });
  });

  describe('Kubernetes configuration loading', () => {
    let loadFromFile: ReturnType<typeof vi.spyOn>;
    let setCurrentContext: ReturnType<typeof vi.spyOn>;
    let loadFromCluster: ReturnType<typeof vi.spyOn>;
    let loadFromDefault: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      loadFromFile = vi
        .spyOn(KubeConfig.prototype, 'loadFromFile')
        .mockImplementation(() => {});
      setCurrentContext = vi
        .spyOn(KubeConfig.prototype, 'setCurrentContext')
        .mockImplementation(() => {});
      loadFromCluster = vi
        .spyOn(KubeConfig.prototype, 'loadFromCluster')
        .mockImplementation(() => {});
      loadFromDefault = vi
        .spyOn(KubeConfig.prototype, 'loadFromDefault')
        .mockImplementation(() => {});
      vi.spyOn(KubeConfig.prototype, 'makeApiClient').mockReturnValue(
        {} as never,
      );
    });

    it('loads from an explicit path and context', () => {
      new GkeCodeExecutor({
        kubeconfigPath: '/path/to/kubeconfig',
        kubeconfigContext: 'test-context',
      });

      expect(loadFromFile).toHaveBeenCalledWith('/path/to/kubeconfig');
      expect(setCurrentContext).toHaveBeenCalledWith('test-context');
      expect(
        vi.mocked(KubeConfig.prototype.makeApiClient),
      ).toHaveBeenCalledTimes(2);
    });

    it('loads from an explicit path without a context', () => {
      new GkeCodeExecutor({kubeconfigPath: '/path/to/kubeconfig'});

      expect(loadFromFile).toHaveBeenCalledWith('/path/to/kubeconfig');
      expect(setCurrentContext).not.toHaveBeenCalled();
    });

    it('wraps errors from an explicit path', () => {
      loadFromFile.mockImplementation(() => {
        throw new Error('bad file');
      });

      expect(() => new GkeCodeExecutor({kubeconfigPath: '/bad'})).toThrow(
        'Failed to configure Kubernetes client from provided path.',
      );
    });

    it('uses in-cluster config when available', () => {
      new GkeCodeExecutor();

      expect(loadFromCluster).toHaveBeenCalledOnce();
      expect(loadFromDefault).not.toHaveBeenCalled();
    });

    it('falls back to the default kubeconfig when not in-cluster', () => {
      loadFromCluster.mockImplementation(() => {
        throw new Error('not in cluster');
      });

      new GkeCodeExecutor();

      expect(loadFromDefault).toHaveBeenCalledOnce();
    });

    it('throws when no configuration can be found', () => {
      loadFromCluster.mockImplementation(() => {
        throw new Error('not in cluster');
      });
      loadFromDefault.mockImplementation(() => {
        throw new Error('no default');
      });

      expect(() => new GkeCodeExecutor()).toThrow(
        'Failed to find any valid Kubernetes configuration.',
      );
    });
  });
});
