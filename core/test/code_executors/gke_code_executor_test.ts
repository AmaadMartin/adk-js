/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  defaultSandboxClientFactory,
  GkeApiClients,
  GkeCodeExecutor,
  GkeCodeExecutorOptions,
  GkeJobsApi,
  GkeJobWatcher,
  GkePodsApi,
  InvocationContext,
  SandboxClient,
  SandboxInfrastructureError,
  SandboxRunResult,
  SandboxTimeoutError,
} from '@google/adk';
import {logger} from '@google/adk/utils/logger.js';
import {ApiException, KubeConfig, V1Job, V1Pod} from '@kubernetes/client-node';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  Mock,
  MockInstance,
  vi,
} from 'vitest';

/** How long a single fake watch connection "lasts" before it closes. */
const WATCH_CONNECTION_MS = 30_000;

interface FakeJobsApi {
  createNamespacedJob: Mock<GkeJobsApi['createNamespacedJob']>;
}

interface FakePodsApi {
  createNamespacedConfigMap: Mock<GkePodsApi['createNamespacedConfigMap']>;
  patchNamespacedConfigMap: Mock<GkePodsApi['patchNamespacedConfigMap']>;
  listNamespacedPod: Mock<GkePodsApi['listNamespacedPod']>;
  readNamespacedPodLog: Mock<GkePodsApi['readNamespacedPodLog']>;
}

interface FakeWatcher {
  watch: Mock<GkeJobWatcher['watch']>;
}

/** Builds a Pod that reports a terminated code container when asked to. */
function makePod(exitCode?: number, containerName = 'code-runner'): V1Pod {
  const pod: V1Pod = {metadata: {name: 'test-pod-name'}};
  if (exitCode !== undefined) {
    pod.status = {
      containerStatuses: [
        {
          name: containerName,
          image: 'python:3.11-slim',
          imageID: '',
          ready: false,
          restartCount: 0,
          state: {terminated: {exitCode}},
        },
      ],
    };
  }
  return pod;
}

function makeJobsApi(): FakeJobsApi {
  return {
    createNamespacedJob: vi
      .fn<GkeJobsApi['createNamespacedJob']>()
      .mockResolvedValue({
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {name: 'adk-exec-x', uid: 'uid-1'},
      }),
  };
}

function makePodsApi(): FakePodsApi {
  return {
    createNamespacedConfigMap: vi
      .fn<GkePodsApi['createNamespacedConfigMap']>()
      .mockResolvedValue({}),
    patchNamespacedConfigMap: vi
      .fn<GkePodsApi['patchNamespacedConfigMap']>()
      .mockResolvedValue({}),
    listNamespacedPod: vi
      .fn<GkePodsApi['listNamespacedPod']>()
      .mockResolvedValue({items: [makePod(0)]}),
    readNamespacedPodLog: vi
      .fn<GkePodsApi['readNamespacedPodLog']>()
      .mockResolvedValue('hello world'),
  };
}

/**
 * Builds a watcher that replays `connections` in order: one array of Jobs per
 * watch connection. Each connection consumes its whole budget of wall-clock
 * time before closing, so the executor's deadline advances the way it would
 * against a real cluster.
 */
function makeWatcher(connections: V1Job[][]): FakeWatcher {
  let call = 0;
  return {
    watch: vi
      .fn<GkeJobWatcher['watch']>()
      .mockImplementation(async (_path, _query, callback, done) => {
        const jobs = connections[call++] ?? [];
        for (const job of jobs) {
          callback('MODIFIED', job);
        }
        if (jobs.length === 0) {
          vi.advanceTimersByTime(WATCH_CONNECTION_MS);
          done(null);
        }
        return new AbortController();
      }),
  };
}

/** Attempts a failing watcher allows before it forces the deadline to pass. */
const MAX_FAILING_ATTEMPTS = 5;

/**
 * Builds a watcher whose every connection ends with `error` and no Job event.
 * After {@link MAX_FAILING_ATTEMPTS} it pushes the clock past a one-second
 * deadline, so a regression that retries a failing watch ends the test with a
 * failed assertion rather than spinning until the runner gives up.
 */
function makeFailingWatcher(error: unknown): FakeWatcher {
  let attempts = 0;
  return {
    watch: vi
      .fn<GkeJobWatcher['watch']>()
      .mockImplementation(async (_path, _query, _callback, done) => {
        attempts += 1;
        if (attempts >= MAX_FAILING_ATTEMPTS) {
          vi.advanceTimersByTime(2_000);
        }
        done(error);
        return new AbortController();
      }),
  };
}

const SUCCEEDED_JOB: V1Job = {status: {succeeded: 1}};
const FAILED_JOB: V1Job = {status: {failed: 1}};
const RUNNING_JOB: V1Job = {status: {active: 1}};

const INVOCATION_CONTEXT = {
  invocationId: 'test-invocation-123',
} as Pick<InvocationContext, 'invocationId'> as InvocationContext;

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

/** A sandbox whose calls are all recorded. */
function makeSandbox(result: SandboxRunResult) {
  return {
    write: vi.fn<SandboxClient['write']>().mockResolvedValue(undefined),
    run: vi.fn<SandboxClient['run']>().mockResolvedValue(result),
    close: vi.fn<SandboxClient['close']>().mockResolvedValue(undefined),
  };
}

describe('GkeCodeExecutor', () => {
  let jobs: FakeJobsApi;
  let pods: FakePodsApi;
  let watcher: FakeWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    jobs = makeJobsApi();
    pods = makePodsApi();
    watcher = makeWatcher([[SUCCEEDED_JOB]]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function apiClients(): GkeApiClients {
    return {jobs, pods, watcher};
  }

  function newExecutor(overrides: GkeCodeExecutorOptions = {}) {
    return new GkeCodeExecutor({apiClients: apiClients(), ...overrides});
  }

  // Ported from adk-python main,
  // tests/unittests/code_executors/test_gke_code_executor.py. The Python test
  // names are kept verbatim so a reviewer can grep for them.
  describe('adk-python reference tests', () => {
    it('test_init_defaults', () => {
      const executor = new GkeCodeExecutor();

      expect(executor.namespace).toBe('default');
      expect(executor.image).toBe('python:3.11-slim');
      expect(executor.timeoutSeconds).toBe(300);
      expect(executor.cpuRequested).toBe('200m');
      expect(executor.memLimit).toBe('512Mi');
      expect(executor.executorType).toBe('job');
    });

    it('test_init_with_overrides', () => {
      const executor = new GkeCodeExecutor({
        namespace: 'test-ns',
        image: 'custom-python:latest',
        timeoutSeconds: 60,
        cpuLimit: '1000m',
        executorType: 'sandbox',
      });

      expect(executor.namespace).toBe('test-ns');
      expect(executor.image).toBe('custom-python:latest');
      expect(executor.timeoutSeconds).toBe(60);
      expect(executor.cpuLimit).toBe('1000m');
      expect(executor.executorType).toBe('sandbox');
      expect(executor.sandboxTemplate).toBe('python-sandbox-template');
    });

    it('test_init_backward_compatibility', () => {
      const executor = new GkeCodeExecutor({
        kubeconfigPath: '/path/to/kubeconfig',
        kubeconfigContext: 'test-context',
        namespace: 'test-ns',
        image: 'test-image',
        timeoutSeconds: 100,
        executorType: 'job',
        cpuRequested: '100m',
        memRequested: '128Mi',
        cpuLimit: '200m',
        memLimit: '256Mi',
        sandboxGatewayName: 'test-gateway',
        sandboxTemplate: 'test-template',
      });

      expect(executor.namespace).toBe('test-ns');
      expect(executor.image).toBe('test-image');
      expect(executor.timeoutSeconds).toBe(100);
      expect(executor.executorType).toBe('job');
      expect(executor.cpuRequested).toBe('100m');
      expect(executor.memRequested).toBe('128Mi');
      expect(executor.cpuLimit).toBe('200m');
      expect(executor.memLimit).toBe('256Mi');
      expect(executor.kubeconfigPath).toBe('/path/to/kubeconfig');
      expect(executor.kubeconfigContext).toBe('test-context');
      expect(executor.sandboxGatewayName).toBe('test-gateway');
      expect(executor.sandboxTemplate).toBe('test-template');
    });

    it('test_init_partial_positional_args', () => {
      const executor = new GkeCodeExecutor({
        kubeconfigPath: '/path/to/kubeconfig',
      });

      expect(executor.kubeconfigPath).toBe('/path/to/kubeconfig');
      expect(executor.kubeconfigContext).toBeUndefined();
    });

    // Divergence. Python raises ImportError here because `k8s-agent-sandbox`
    // gates sandbox mode. npm has no equivalent package, so adk-js ships its
    // own client and construction cannot fail this way.
    it('test_init_sandbox_missing_dependency', () => {
      const executor = new GkeCodeExecutor({executorType: 'sandbox'});

      expect(executor.executorType).toBe('sandbox');
      expect(executor.sandboxClientFactory).toBe(defaultSandboxClientFactory);
    });

    it('test_execute_code_success', async () => {
      const result = await executeWith(newExecutor());

      expect(result.stdout).toBe('hello world');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(result.outputFiles).toEqual([]);
      expect(pods.createNamespacedConfigMap).toHaveBeenCalledOnce();
      expect(jobs.createNamespacedJob).toHaveBeenCalledOnce();
      expect(pods.patchNamespacedConfigMap).toHaveBeenCalledOnce();
      expect(pods.readNamespacedPodLog).toHaveBeenCalledOnce();
    });

    it('test_execute_code_job_failed', async () => {
      watcher = makeWatcher([[FAILED_JOB]]);
      pods.listNamespacedPod.mockResolvedValue({items: [makePod(2)]});
      pods.readNamespacedPodLog.mockResolvedValue(
        'Traceback...\nValueError: failure',
      );

      const result = await executeWith(newExecutor());

      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Job failed. Logs:');
      expect(result.stderr).toContain('ValueError: failure');
      expect(result.exitCode).toBe(2);
    });

    it('test_execute_code_job_failed_without_terminated_container', async () => {
      watcher = makeWatcher([[FAILED_JOB]]);
      pods.listNamespacedPod.mockResolvedValue({items: [makePod()]});
      pods.readNamespacedPodLog.mockResolvedValue('gone');

      const result = await executeWith(newExecutor());

      expect(result.exitCode).toBe(1);
    });

    it('test_execute_code_api_exception', async () => {
      pods.createNamespacedConfigMap.mockRejectedValue(
        new ApiException(500, 'msg', {reason: 'Test API Error'}, {}),
      );

      const result = await executeWith(newExecutor());

      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('Kubernetes API error: Test API Error');
      expect(result.exitCode).toBeUndefined();
    });

    it('test_execute_code_timeout', async () => {
      watcher = makeWatcher([]);
      pods.readNamespacedPodLog.mockResolvedValue('Still running...');

      const result = await executeWith(newExecutor({timeoutSeconds: 1}));

      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Executor timed out');
      expect(result.stderr).toContain('did not complete within 1s');
      expect(result.stderr).toContain('Pod Logs:\nStill running...');
      expect(result.exitCode).toBeUndefined();
    });

    it('test_create_job_manifest_structure', async () => {
      await executeWith(
        newExecutor({namespace: 'test-ns', image: 'test-img:v1'}),
      );

      const job = jobs.createNamespacedJob.mock.calls[0][0].body;
      expect(job.apiVersion).toBe('batch/v1');
      expect(job.kind).toBe('Job');
      expect(job.metadata?.name).toMatch(/^adk-exec-[0-9a-f]{10}$/);
      expect(
        job.metadata?.annotations?.['adk.agent.google.com/invocation-id'],
      ).toBe('test-invocation-123');
      expect(job.spec?.backoffLimit).toBe(0);
      expect(job.spec?.ttlSecondsAfterFinished).toBe(600);

      const podSpec = job.spec?.template.spec;
      expect(podSpec?.restartPolicy).toBe('Never');
      expect(podSpec?.automountServiceAccountToken).toBe(false);
      expect(podSpec?.runtimeClassName).toBe('gvisor');
      expect(podSpec?.tolerations).toHaveLength(1);
      expect(podSpec?.tolerations?.[0].value).toBe('gvisor');
      expect(podSpec?.volumes).toHaveLength(1);
      expect(podSpec?.volumes?.[0].name).toBe('code-volume');
      expect(podSpec?.volumes?.[0].configMap?.name).toMatch(
        /^code-src-adk-exec-/,
      );

      const container = podSpec?.containers[0];
      expect(container?.name).toBe('code-runner');
      expect(container?.image).toBe('test-img:v1');
      expect(container?.command).toEqual(['python3', '/app/code.py']);
      expect(container?.volumeMounts?.[0].mountPath).toBe('/app');
      expect(container?.securityContext).toEqual({
        runAsNonRoot: true,
        runAsUser: 1001,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: {drop: ['ALL']},
      });
      expect(container?.resources?.requests).toEqual({
        cpu: '200m',
        memory: '256Mi',
      });
      expect(container?.resources?.limits).toEqual({
        cpu: '500m',
        memory: '512Mi',
      });
    });

    it('test_execute_code_forks_to_sandbox', async () => {
      const sandbox = makeSandbox({stdout: 'sandbox stdout'});
      const sandboxClientFactory = vi.fn().mockResolvedValue(sandbox);

      const result = await executeWith(
        newExecutor({executorType: 'sandbox', sandboxClientFactory}),
        'print("sandbox")',
      );

      expect(result.stdout).toBe('sandbox stdout');
      expect(sandboxClientFactory).toHaveBeenCalledOnce();
      expect(sandbox.run).toHaveBeenCalledOnce();
      expect(jobs.createNamespacedJob).not.toHaveBeenCalled();
    });

    it('test_execute_code_sandbox_connection_error', async () => {
      const sandboxClientFactory = vi
        .fn()
        .mockRejectedValue(new Error('Connection failed'));

      await expect(
        executeWith(
          newExecutor({executorType: 'sandbox', sandboxClientFactory}),
        ),
      ).rejects.toThrow('Connection failed');
    });

    it('test_execute_code_sandbox_runtime_error', async () => {
      const sandboxClientFactory = vi
        .fn()
        .mockRejectedValue(new SandboxInfrastructureError('Gateway not found'));

      await expect(
        executeWith(
          newExecutor({executorType: 'sandbox', sandboxClientFactory}),
        ),
      ).rejects.toThrow('Sandbox infrastructure error: Gateway not found');
    });

    it('test_execute_code_sandbox_timeout_error', async () => {
      const sandboxClientFactory = vi
        .fn()
        .mockRejectedValue(new SandboxTimeoutError('Execution timed out'));

      const result = await executeWith(
        newExecutor({executorType: 'sandbox', sandboxClientFactory}),
      );

      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('Sandbox timed out: Execution timed out');
    });

    it('test_execute_code_forks_to_job', async () => {
      const sandboxClientFactory = vi.fn();
      pods.listNamespacedPod.mockResolvedValue({items: [makePod()]});
      pods.readNamespacedPodLog.mockResolvedValue('job stdout');

      const result = await executeWith(
        newExecutor({executorType: 'job', sandboxClientFactory}),
      );

      expect(result.stdout).toBe('job stdout');
      // No terminated container to read, so the succeeding Job implies 0.
      expect(result.exitCode).toBe(0);
      expect(jobs.createNamespacedJob).toHaveBeenCalledOnce();
      expect(sandboxClientFactory).not.toHaveBeenCalled();
    });

    it('test_execute_in_sandbox_returns_stderr', async () => {
      const sandbox = makeSandbox({stdout: '', stderr: 'oops\n'});
      const sandboxClientFactory = vi.fn().mockResolvedValue(sandbox);
      const code = "import sys; print('oops', file=sys.stderr)";

      const result = await executeWith(
        newExecutor({executorType: 'sandbox', sandboxClientFactory}),
        code,
      );

      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('oops\n');
      expect(sandbox.write).toHaveBeenCalledWith('script.py', code);
      expect(sandbox.run).toHaveBeenCalledWith('python3 script.py');
    });
  });

  describe('Kubernetes API error reporting', () => {
    async function stderrForBody(body: unknown, message = 'msg') {
      pods.createNamespacedConfigMap.mockRejectedValue(
        new ApiException(500, message, body, {}),
      );
      const result = await executeWith(newExecutor());
      return result.stderr;
    }

    it('reports the reason from a JSON string body', async () => {
      const stderr = await stderrForBody(
        JSON.stringify({reason: 'Test API Error'}),
      );

      expect(stderr).toBe('Kubernetes API error: Test API Error');
    });

    it('falls back to the message field when reason is absent', async () => {
      const stderr = await stderrForBody(JSON.stringify({message: 'only'}));

      expect(stderr).toBe('Kubernetes API error: only');
    });

    it('reads reason from an already-parsed object body', async () => {
      const stderr = await stderrForBody({reason: 'object reason'});

      expect(stderr).toBe('Kubernetes API error: object reason');
    });

    it('falls back to the exception message for a non-JSON body', async () => {
      const stderr = await stderrForBody('not-json-at-all', 'boom');

      expect(stderr).toContain('Kubernetes API error:');
      expect(stderr).toContain('boom');
    });

    it('falls back to the exception message for a null body', async () => {
      const stderr = await stderrForBody('null', 'null-body');

      expect(stderr).toContain('null-body');
    });

    it('reports a generic reason when no message is available', async () => {
      const err = new ApiException(500, '', 'not-json', {});
      err.message = '';
      pods.createNamespacedConfigMap.mockRejectedValue(err);

      const result = await executeWith(newExecutor());

      expect(result.stderr).toBe('Kubernetes API error: Unknown error');
    });

    it('reports a non-Error thrown value', async () => {
      pods.createNamespacedConfigMap.mockRejectedValue('weird failure');

      const result = await executeWith(newExecutor());

      expect(result.stderr).toBe(
        'An unexpected executor error occurred: weird failure',
      );
    });

    it('reports a missing Pod as an executor error', async () => {
      pods.listNamespacedPod.mockResolvedValue({items: []});

      const result = await executeWith(newExecutor());

      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('An unexpected executor error occurred');
      expect(result.stderr).toContain('Could not find Pod');
    });
  });

  describe('ConfigMap and owner reference', () => {
    it('writes the code into the ConfigMap', async () => {
      await executeWith(newExecutor(), 'print("hi")');

      const {body} = pods.createNamespacedConfigMap.mock.calls[0][0];
      expect(body.data?.['code.py']).toBe('print("hi")');
    });

    it('patches the ConfigMap to be owned by the Job', async () => {
      await executeWith(newExecutor());

      const {body} = pods.patchNamespacedConfigMap.mock.calls[0][0];
      const ownerRef = body.metadata.ownerReferences[0];
      expect(ownerRef.uid).toBe('uid-1');
      expect(ownerRef.name).toBe('adk-exec-x');
      expect(ownerRef.controller).toBe(true);
    });

    it('sends the patch as a strategic merge patch', async () => {
      await executeWith(newExecutor());

      const options = pods.patchNamespacedConfigMap.mock.calls[0][1];
      expect(options?.middleware).toHaveLength(1);
    });

    it('uses fallbacks when the created Job lacks metadata', async () => {
      jobs.createNamespacedJob.mockResolvedValue({});

      await executeWith(newExecutor());

      const {body} = pods.patchNamespacedConfigMap.mock.calls[0][0];
      const ownerRef = body.metadata.ownerReferences[0];
      expect(ownerRef.apiVersion).toBe('batch/v1');
      expect(ownerRef.kind).toBe('Job');
      expect(ownerRef.name).toBe('');
      expect(ownerRef.uid).toBe('');
    });

    it('continues and warns when the owner-reference patch fails', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      pods.patchNamespacedConfigMap.mockRejectedValue(
        new ApiException(500, 'msg', {reason: 'patch denied'}, {}),
      );

      const result = await executeWith(newExecutor());

      expect(result.stdout).toBe('hello world');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to set ownerReference'),
      );
    });

    it('rethrows non-API errors from the owner-reference patch', async () => {
      pods.patchNamespacedConfigMap.mockRejectedValue(
        new Error('unexpected patch error'),
      );

      const result = await executeWith(newExecutor());

      expect(result.stderr).toContain('An unexpected executor error occurred');
      expect(result.stderr).toContain('unexpected patch error');
    });
  });

  describe('Job watching', () => {
    it('re-establishes the watch when a connection closes early', async () => {
      watcher = makeWatcher([[], [SUCCEEDED_JOB]]);

      const result = await executeWith(newExecutor({timeoutSeconds: 300}));

      expect(result.stdout).toBe('hello world');
      expect(result.stderr).toBe('');
      expect(watcher.watch).toHaveBeenCalledTimes(2);
    });

    it('keeps watching when the client closes a connection at its cap', async () => {
      let attempt = 0;
      watcher.watch.mockImplementation(
        async (_path, _query, callback, done) => {
          if (attempt++ === 0) {
            vi.advanceTimersByTime(WATCH_CONNECTION_MS);
            done(
              new DOMException(
                'The operation was aborted due to timeout',
                'TimeoutError',
              ),
            );
          } else {
            callback('MODIFIED', SUCCEEDED_JOB);
          }
          return new AbortController();
        },
      );

      const result = await executeWith(newExecutor({timeoutSeconds: 300}));

      expect(result.stdout).toBe('hello world');
      expect(watcher.watch).toHaveBeenCalledTimes(2);
    });

    it('reports a watch the API server rejects, without retrying', async () => {
      watcher = makeFailingWatcher(
        Object.assign(new Error('Forbidden'), {statusCode: 403}),
      );

      const result = await executeWith(newExecutor({timeoutSeconds: 1}));

      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('Kubernetes API error: Forbidden');
      expect(result.exitCode).toBeUndefined();
      expect(watcher.watch).toHaveBeenCalledOnce();
    });

    it('reports a watch that cannot reach the API server', async () => {
      watcher = makeFailingWatcher(new Error('fetch failed'));

      const result = await executeWith(newExecutor({timeoutSeconds: 1}));

      expect(result.stderr).toBe(
        'An unexpected executor error occurred: fetch failed',
      );
      expect(watcher.watch).toHaveBeenCalledOnce();
    });

    it('ignores non-terminal Job events on the same connection', async () => {
      watcher = makeWatcher([[RUNNING_JOB, RUNNING_JOB, SUCCEEDED_JOB]]);

      const result = await executeWith(newExecutor());

      expect(result.stdout).toBe('hello world');
      expect(watcher.watch).toHaveBeenCalledOnce();
    });

    it('watches the Job by name in its own namespace', async () => {
      await executeWith(newExecutor({namespace: 'agents'}));

      const [path, query] = watcher.watch.mock.calls[0];
      expect(path).toBe('/apis/batch/v1/namespaces/agents/jobs');
      expect(query['fieldSelector']).toMatch(/^metadata\.name=adk-exec-/);
      expect(query['timeoutSeconds']).toBe(300);
    });

    it('closes the watch connection on every path', async () => {
      const controllers: AbortController[] = [];
      watcher.watch.mockImplementation(async (_path, _query, callback) => {
        callback('MODIFIED', SUCCEEDED_JOB);
        const controller = new AbortController();
        controllers.push(controller);
        return controller;
      });

      await executeWith(newExecutor());

      expect(controllers).toHaveLength(1);
      expect(controllers[0].signal.aborted).toBe(true);
    });

    it('closes the watch connection when reading the Pod throws', async () => {
      const controller = new AbortController();
      watcher.watch.mockImplementation(async (_path, _query, callback) => {
        callback('MODIFIED', SUCCEEDED_JOB);
        return controller;
      });
      pods.listNamespacedPod.mockRejectedValue(new Error('list failed'));

      const result = await executeWith(newExecutor());

      expect(result.stderr).toContain('list failed');
      expect(controller.signal.aborted).toBe(true);
    });
  });

  describe('exit status', () => {
    it('ignores the status of a container that is not code-runner', async () => {
      pods.listNamespacedPod.mockResolvedValue({
        items: [makePod(7, 'sidecar')],
      });

      const result = await executeWith(newExecutor());

      expect(result.exitCode).toBe(0);
    });

    it('reports a non-zero status from a Job that still succeeded', async () => {
      pods.listNamespacedPod.mockResolvedValue({items: [makePod(3)]});

      const result = await executeWith(newExecutor());

      expect(result.exitCode).toBe(3);
    });

    it('reports 0 from a failed Job whose container exited cleanly', async () => {
      watcher = makeWatcher([[FAILED_JOB]]);
      pods.listNamespacedPod.mockResolvedValue({items: [makePod(0)]});

      const result = await executeWith(newExecutor());

      expect(result.exitCode).toBe(0);
    });

    it('reports no status when the container never terminated', async () => {
      pods.listNamespacedPod.mockResolvedValue({
        items: [
          {
            metadata: {name: 'pod-1'},
            status: {
              containerStatuses: [
                {
                  name: 'code-runner',
                  image: 'python:3.11-slim',
                  imageID: '',
                  ready: true,
                  restartCount: 0,
                  state: {running: {}},
                },
              ],
            },
          },
        ],
      });

      const result = await executeWith(newExecutor());

      expect(result.exitCode).toBe(0);
    });
  });

  describe('kubeconfig resolution', () => {
    let loadFromFile: MockInstance<KubeConfig['loadFromFile']>;
    let setCurrentContext: MockInstance<KubeConfig['setCurrentContext']>;
    let loadFromCluster: MockInstance<KubeConfig['loadFromCluster']>;
    let loadFromDefault: MockInstance<KubeConfig['loadFromDefault']>;

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
    });

    /**
     * Runs an executor far enough to resolve its clients. The Job creation
     * fails against the unconfigured KubeConfig, which is the point: the
     * kubeconfig calls have already happened by then.
     */
    async function resolveClients(options: GkeCodeExecutorOptions = {}) {
      return executeWith(new GkeCodeExecutor(options));
    }

    it('loads from an explicit path and context', async () => {
      await resolveClients({
        kubeconfigPath: '/path/to/kubeconfig',
        kubeconfigContext: 'test-context',
      });

      expect(loadFromFile).toHaveBeenCalledWith('/path/to/kubeconfig');
      expect(setCurrentContext).toHaveBeenCalledWith('test-context');
      expect(loadFromCluster).not.toHaveBeenCalled();
    });

    it('loads from an explicit path without a context', async () => {
      await resolveClients({kubeconfigPath: '/path/to/kubeconfig'});

      expect(loadFromFile).toHaveBeenCalledWith('/path/to/kubeconfig');
      expect(setCurrentContext).not.toHaveBeenCalled();
    });

    it('wraps a failure to read the explicit path', async () => {
      loadFromFile.mockImplementation(() => {
        throw new Error('bad file');
      });

      const result = await resolveClients({kubeconfigPath: '/bad'});

      expect(result.stderr).toContain(
        'Failed to configure Kubernetes client from provided path.',
      );
    });

    it('uses in-cluster config when it is available', async () => {
      await resolveClients();

      expect(loadFromCluster).toHaveBeenCalledOnce();
      expect(loadFromDefault).not.toHaveBeenCalled();
    });

    it('falls back to the default kubeconfig when not in a cluster', async () => {
      loadFromCluster.mockImplementation(() => {
        throw new Error('not in cluster');
      });

      await resolveClients();

      expect(loadFromDefault).toHaveBeenCalledOnce();
    });

    it('resolves the clients once across executions', async () => {
      const executor = new GkeCodeExecutor();

      await executeWith(executor);
      await executeWith(executor);

      expect(loadFromCluster).toHaveBeenCalledOnce();
    });

    it('reports that no configuration could be found', async () => {
      loadFromCluster.mockImplementation(() => {
        throw new Error('not in cluster');
      });
      loadFromDefault.mockImplementation(() => {
        throw new Error('no default');
      });

      const result = await resolveClients();

      expect(result.stderr).toContain(
        'Failed to find any valid Kubernetes configuration.',
      );
    });
  });

  describe('sandbox lifecycle', () => {
    it('reports the status the sandbox command exited with', async () => {
      const sandbox = makeSandbox({stdout: '', stderr: 'boom', exitCode: 3});
      const sandboxClientFactory = vi.fn().mockResolvedValue(sandbox);

      const result = await executeWith(
        newExecutor({executorType: 'sandbox', sandboxClientFactory}),
      );

      expect(result.exitCode).toBe(3);
      expect(result.stderr).toBe('boom');
    });

    it('reports no status when the sandbox does not give one', async () => {
      const sandbox = makeSandbox({stdout: 'ok'});
      const sandboxClientFactory = vi.fn().mockResolvedValue(sandbox);

      const result = await executeWith(
        newExecutor({executorType: 'sandbox', sandboxClientFactory}),
      );

      expect(result.exitCode).toBeUndefined();
    });

    it('closes the sandbox after a successful run', async () => {
      const sandbox = makeSandbox({stdout: 'ok'});
      const sandboxClientFactory = vi.fn().mockResolvedValue(sandbox);

      await executeWith(
        newExecutor({executorType: 'sandbox', sandboxClientFactory}),
      );

      expect(sandbox.close).toHaveBeenCalledOnce();
    });

    it('closes the sandbox when the run fails', async () => {
      const sandbox = makeSandbox({stdout: ''});
      sandbox.run.mockRejectedValue(new Error('run failed'));
      const sandboxClientFactory = vi.fn().mockResolvedValue(sandbox);

      await expect(
        executeWith(
          newExecutor({executorType: 'sandbox', sandboxClientFactory}),
        ),
      ).rejects.toThrow('run failed');
      expect(sandbox.close).toHaveBeenCalledOnce();
    });

    it('swallows an error thrown while closing the sandbox', async () => {
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const sandbox = makeSandbox({stdout: 'ok'});
      sandbox.close.mockRejectedValue(new Error('close failed'));
      const sandboxClientFactory = vi.fn().mockResolvedValue(sandbox);

      const result = await executeWith(
        newExecutor({executorType: 'sandbox', sandboxClientFactory}),
      );

      expect(result.stdout).toBe('ok');
      expect(error).toHaveBeenCalledWith(
        'Failed to close sandbox',
        expect.any(Error),
      );
    });

    it('treats an AbortSignal timeout as a sandbox timeout', async () => {
      const timeout = new Error('aborted');
      timeout.name = 'TimeoutError';
      const sandboxClientFactory = vi.fn().mockRejectedValue(timeout);

      const result = await executeWith(
        newExecutor({executorType: 'sandbox', sandboxClientFactory}),
      );

      expect(result.stderr).toBe('Sandbox timed out: aborted');
    });

    it('does not close a sandbox that was never opened', async () => {
      const sandboxClientFactory = vi
        .fn()
        .mockRejectedValue(new SandboxTimeoutError('no sandbox'));

      const result = await executeWith(
        newExecutor({executorType: 'sandbox', sandboxClientFactory}),
      );

      expect(result.stderr).toBe('Sandbox timed out: no sandbox');
    });
  });
});
