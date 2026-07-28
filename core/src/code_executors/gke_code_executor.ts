/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';

import {
  ApiException,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  PatchStrategy,
  setHeaderOptions,
  type V1ConfigMap,
  type V1Job,
  type V1OwnerReference,
} from '@kubernetes/client-node';

import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {CodeExecutionResult} from './code_execution_utils.js';

const DEFAULT_NAMESPACE = 'default';
const DEFAULT_IMAGE = 'python:3.11-slim';
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_CPU_REQUESTED = '200m';
const DEFAULT_MEM_REQUESTED = '256Mi';
const DEFAULT_CPU_LIMIT = '500m';
const DEFAULT_MEM_LIMIT = '512Mi';

const POLL_INTERVAL_MS = 1000;
const JOB_TTL_SECONDS = 600;
const RUN_AS_USER = 1001;
const GVISOR_RUNTIME_CLASS = 'gvisor';
const CODE_MOUNT_PATH = '/app';
const CODE_FILE_NAME = 'code.py';
const CONTAINER_NAME = 'code-runner';
const VOLUME_NAME = 'code-volume';
const INVOCATION_ID_ANNOTATION = 'adk.agent.google.com/invocation-id';

/**
 * Container resource sizing used to build the Job manifest.
 */
interface JobResourceConfig {
  image: string;
  cpuRequested: string;
  memRequested: string;
  cpuLimit: string;
  memLimit: string;
}

/**
 * Options for {@link GkeCodeExecutor}. All values are optional; the executor is
 * usable with `new GkeCodeExecutor()` because every operational value has a
 * default.
 */
export interface GkeCodeExecutorOptions {
  /** Target namespace for the Job and ConfigMap. Default `'default'`. */
  namespace?: string;
  /** Container image used to run the code. Default `'python:3.11-slim'`. */
  image?: string;
  /** Maximum time to wait for Job completion. Default `300`. */
  timeoutSeconds?: number;
  /** Requested CPU (Kubernetes quantity). Default `'200m'`. */
  cpuRequested?: string;
  /** Requested memory (Kubernetes quantity). Default `'256Mi'`. */
  memRequested?: string;
  /** CPU limit (Kubernetes quantity). Default `'500m'`. */
  cpuLimit?: string;
  /** Memory limit (Kubernetes quantity). Default `'512Mi'`. */
  memLimit?: string;
  /** Explicit kubeconfig file path. */
  kubeconfigPath?: string;
  /** Explicit context within the kubeconfig file. */
  kubeconfigContext?: string;
  /** Pre-configured Batch API client. Primarily for testing/DI. */
  batchApi?: BatchV1Api;
  /** Pre-configured Core API client. Primarily for testing/DI. */
  coreApi?: CoreV1Api;
}

/**
 * Sleeps for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts a human-readable reason from a Kubernetes {@link ApiException}.
 *
 * In `@kubernetes/client-node` v1.x, `err.body` is a JSON string. It is parsed
 * to read `.reason` (then `.message`), falling back to `err.message` and
 * finally a generic string. The parse is guarded so a non-JSON body cannot
 * throw.
 */
function getApiErrorReason(err: ApiException<unknown>): string {
  try {
    const body: unknown =
      typeof err.body === 'string' ? JSON.parse(err.body) : err.body;
    if (body && typeof body === 'object') {
      const {reason, message} = body as {reason?: string; message?: string};
      if (reason) {
        return reason;
      }
      if (message) {
        return message;
      }
    }
  } catch {
    // Body was not JSON; fall back to the exception message below.
  }
  return err.message || 'Unknown error';
}

/**
 * Builds the hardened {@link V1Job} manifest that runs the code in a
 * gVisor-sandboxed Pod. The manifest is a plain typed object literal (the v1.x
 * models are interfaces, not constructors).
 */
function buildJobManifest(
  jobName: string,
  configmapName: string,
  invocationId: string,
  config: JobResourceConfig,
): V1Job {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      annotations: {[INVOCATION_ID_ANNOTATION]: invocationId},
    },
    spec: {
      // Do not retry the Job on failure.
      backoffLimit: 0,
      // Let the Kubernetes TTL controller garbage-collect the Job and its Pod.
      ttlSecondsAfterFinished: JOB_TTL_SECONDS,
      template: {
        spec: {
          restartPolicy: 'Never',
          // Request the gVisor runtime for kernel-level sandboxing.
          runtimeClassName: GVISOR_RUNTIME_CLASS,
          tolerations: [
            {
              key: 'sandbox.gke.io/runtime',
              operator: 'Equal',
              value: GVISOR_RUNTIME_CLASS,
              effect: 'NoSchedule',
            },
          ],
          volumes: [
            {
              name: VOLUME_NAME,
              configMap: {name: configmapName},
            },
          ],
          containers: [
            {
              name: CONTAINER_NAME,
              image: config.image,
              command: ['python3', `${CODE_MOUNT_PATH}/${CODE_FILE_NAME}`],
              volumeMounts: [{name: VOLUME_NAME, mountPath: CODE_MOUNT_PATH}],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: RUN_AS_USER,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: {drop: ['ALL']},
              },
              resources: {
                requests: {
                  cpu: config.cpuRequested,
                  memory: config.memRequested,
                },
                limits: {cpu: config.cpuLimit, memory: config.memLimit},
              },
            },
          ],
        },
      },
    },
  };
}

/**
 * Executes Python code in a secure gVisor-sandboxed Pod on GKE (Job mode).
 *
 * Securely runs model-generated code by dynamically creating a Kubernetes Job
 * for each execution request. The code is mounted via a ConfigMap and the Pod
 * is hardened with a strict security context, resource limits, and the gVisor
 * runtime. Completed Jobs and Pods are garbage-collected automatically via the
 * TTL controller.
 *
 * Key features:
 * - Sandboxed execution using the gVisor runtime.
 * - Ephemeral, per-execution environments using Kubernetes Jobs.
 * - Secure-by-default Pod configuration (non-root, no privileges, read-only
 *   root filesystem, all capabilities dropped).
 * - Automatic garbage collection of completed Jobs and Pods via TTL.
 *
 * RBAC permissions:
 * This executor requires a ServiceAccount whose Role includes:
 * - configmaps: `create`, `delete`, `get`, `patch` (core API group) — for
 *   creating the code ConfigMap and patching its ownerReferences.
 * - jobs: `get`, `list`, `watch`, `create`, `delete` (batch API group) — for
 *   creating and polling the Job.
 * - pods and pods/log: `get`, `list` (core API group) — for reading the
 *   completed Job's Pod logs.
 *
 * Manual verification: deploy to a GKE cluster with a gVisor node pool and the
 * `gvisor` RuntimeClass, grant the RBAC above, then instantiate
 * `new GkeCodeExecutor({namespace})` in-cluster and run `print("hello world")`;
 * `stdout` should be `'hello world'` and the Job/ConfigMap should be
 * garbage-collected after the TTL.
 */
@experimental
export class GkeCodeExecutor extends BaseCodeExecutor {
  private readonly namespace: string;
  private readonly image: string;
  private readonly timeoutSeconds: number;
  private readonly cpuRequested: string;
  private readonly memRequested: string;
  private readonly cpuLimit: string;
  private readonly memLimit: string;
  private readonly batchApi: BatchV1Api;
  private readonly coreApi: CoreV1Api;

  /**
   * Initializes the executor and the Kubernetes API clients.
   *
   * Cluster credentials are resolved in order: an explicit `kubeconfigPath`
   * (with optional `kubeconfigContext`), then in-cluster config, then the local
   * default kubeconfig. When both `batchApi` and `coreApi` are supplied, all
   * KubeConfig loading is skipped and the injected clients are used directly.
   */
  constructor(options: GkeCodeExecutorOptions = {}) {
    super();
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.image = options.image ?? DEFAULT_IMAGE;
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.cpuRequested = options.cpuRequested ?? DEFAULT_CPU_REQUESTED;
    this.memRequested = options.memRequested ?? DEFAULT_MEM_REQUESTED;
    this.cpuLimit = options.cpuLimit ?? DEFAULT_CPU_LIMIT;
    this.memLimit = options.memLimit ?? DEFAULT_MEM_LIMIT;

    const {batchApi, coreApi} = resolveApiClients(options);
    this.batchApi = batchApi;
    this.coreApi = coreApi;
  }

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const {invocationContext, codeExecutionInput} = params;
    return this.executeAsJob(
      codeExecutionInput.code,
      invocationContext.invocationId,
    );
  }

  /**
   * Orchestrates the secure execution of a code snippet on GKE. Never throws:
   * Kubernetes API errors, Job failures, and timeouts are returned as `stderr`
   * results.
   */
  private async executeAsJob(
    code: string,
    invocationId: string,
  ): Promise<CodeExecutionResult> {
    const jobName = `adk-exec-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const configmapName = `code-src-${jobName}`;

    try {
      await this.createCodeConfigMap(configmapName, code);
      const jobManifest = buildJobManifest(
        jobName,
        configmapName,
        invocationId,
        {
          image: this.image,
          cpuRequested: this.cpuRequested,
          memRequested: this.memRequested,
          cpuLimit: this.cpuLimit,
          memLimit: this.memLimit,
        },
      );
      const createdJob = await this.batchApi.createNamespacedJob({
        namespace: this.namespace,
        body: jobManifest,
      });
      await this.addOwnerReference(createdJob, configmapName);

      logger.debug(
        `Submitted Job '${jobName}' to namespace '${this.namespace}'.`,
      );
      return await this.waitForJobCompletion(jobName);
    } catch (err) {
      if (err instanceof ApiException) {
        return this.errorResult(
          `Kubernetes API error: ${getApiErrorReason(err)}`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return this.errorResult(
        `An unexpected executor error occurred: ${message}`,
      );
    }
  }

  /**
   * Polls the Job until it reaches a terminal state, returning its Pod logs as
   * `stdout` (success) or `stderr` (failure/timeout).
   */
  private async waitForJobCompletion(
    jobName: string,
  ): Promise<CodeExecutionResult> {
    const maxAttempts = Math.max(
      1,
      Math.ceil((this.timeoutSeconds * 1000) / POLL_INTERVAL_MS),
    );

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const job = await this.batchApi.readNamespacedJob({
        name: jobName,
        namespace: this.namespace,
      });
      if (job.status?.succeeded) {
        logger.debug(`Job '${jobName}' succeeded.`);
        return {
          stdout: await this.getPodLogs(jobName),
          stderr: '',
          outputFiles: [],
        };
      }
      if (job.status?.failed) {
        logger.debug(`Job '${jobName}' failed.`);
        const logs = await this.getPodLogs(jobName);
        return this.errorResult(`Job failed. Logs:\n${logs}`);
      }
      await sleep(POLL_INTERVAL_MS);
    }

    logger.debug(`Job '${jobName}' timed out.`);
    const logs = await this.getPodLogs(jobName);
    return this.errorResult(
      `Executor timed out: Job '${jobName}' did not complete within ` +
        `${this.timeoutSeconds}s.\n\nPod Logs:\n${logs}`,
    );
  }

  /**
   * Retrieves logs from the Pod created by the given Job.
   *
   * @throws Error if no Pod can be found for the Job.
   */
  private async getPodLogs(jobName: string): Promise<string> {
    const pods = await this.coreApi.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `job-name=${jobName}`,
      limit: 1,
    });
    const podName = pods.items[0]?.metadata?.name;
    if (!podName) {
      throw new Error(
        `Could not find Pod for Job '${jobName}' to retrieve logs.`,
      );
    }
    return this.coreApi.readNamespacedPodLog({
      name: podName,
      namespace: this.namespace,
    });
  }

  /**
   * Creates a ConfigMap holding the code to run, mounted into the Pod.
   */
  private async createCodeConfigMap(name: string, code: string): Promise<void> {
    const body: V1ConfigMap = {
      metadata: {name},
      data: {[CODE_FILE_NAME]: code},
    };
    await this.coreApi.createNamespacedConfigMap({
      namespace: this.namespace,
      body,
    });
  }

  /**
   * Patches the ConfigMap so it is owned by the Job and garbage-collected with
   * it. Failure to patch is non-fatal: the code has already been submitted, so
   * a warning is logged and execution continues.
   */
  private async addOwnerReference(
    ownerJob: V1Job,
    configmapName: string,
  ): Promise<void> {
    const ownerReference: V1OwnerReference = {
      apiVersion: ownerJob.apiVersion ?? 'batch/v1',
      kind: ownerJob.kind ?? 'Job',
      name: ownerJob.metadata?.name ?? '',
      uid: ownerJob.metadata?.uid ?? '',
      controller: true,
    };
    const patchBody = {metadata: {ownerReferences: [ownerReference]}};

    try {
      await this.coreApi.patchNamespacedConfigMap(
        {name: configmapName, namespace: this.namespace, body: patchBody},
        setHeaderOptions('Content-Type', PatchStrategy.StrategicMergePatch),
      );
      logger.debug(
        `Set Job '${ownerReference.name}' as owner of ConfigMap '${configmapName}'.`,
      );
    } catch (err) {
      if (err instanceof ApiException) {
        logger.warn(
          `Failed to set ownerReference on ConfigMap '${configmapName}'. ` +
            `Manual cleanup is required. Reason: ${getApiErrorReason(err)}`,
        );
        return;
      }
      throw err;
    }
  }

  /**
   * Builds a failure {@link CodeExecutionResult} with the given stderr message.
   */
  private errorResult(stderr: string): CodeExecutionResult {
    return {stdout: '', stderr, outputFiles: []};
  }
}

/**
 * Resolves the Batch and Core API clients. When both clients are injected they
 * are used directly; otherwise a {@link KubeConfig} is loaded from an explicit
 * path, the in-cluster config, or the local default (in that order).
 */
function resolveApiClients(options: GkeCodeExecutorOptions): {
  batchApi: BatchV1Api;
  coreApi: CoreV1Api;
} {
  if (options.batchApi && options.coreApi) {
    return {batchApi: options.batchApi, coreApi: options.coreApi};
  }

  const kc = new KubeConfig();
  if (options.kubeconfigPath) {
    try {
      logger.debug(
        `Using explicit kubeconfig from '${options.kubeconfigPath}'.`,
      );
      kc.loadFromFile(options.kubeconfigPath);
      if (options.kubeconfigContext) {
        kc.setCurrentContext(options.kubeconfigContext);
      }
    } catch {
      throw new Error(
        'Failed to configure Kubernetes client from provided path.',
      );
    }
  } else {
    try {
      kc.loadFromCluster();
      logger.debug('Using in-cluster Kubernetes configuration.');
    } catch {
      try {
        logger.debug(
          'In-cluster config not found. Falling back to default local kubeconfig.',
        );
        kc.loadFromDefault();
      } catch {
        throw new Error('Failed to find any valid Kubernetes configuration.');
      }
    }
  }

  return {
    batchApi: kc.makeApiClient(BatchV1Api),
    coreApi: kc.makeApiClient(CoreV1Api),
  };
}
