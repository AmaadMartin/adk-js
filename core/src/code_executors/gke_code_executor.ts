/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';

import type {
  ApiException,
  BatchV1Api,
  ConfigurationOptions,
  CoreV1Api,
  V1ConfigMap,
  V1Job,
  V1OwnerReference,
  V1Pod,
} from '@kubernetes/client-node';

import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {defaultSandboxClientFactory} from './agent_sandbox_client.js';
import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {CodeExecutionResult} from './code_execution_utils.js';
import {
  DEFAULT_SANDBOX_TEMPLATE,
  SandboxClient,
  SandboxClientFactory,
  SandboxInfrastructureError,
  SandboxTimeoutError,
} from './sandbox_client.js';

const DEFAULT_NAMESPACE = 'default';
const DEFAULT_IMAGE = 'python:3.11-slim';
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_CPU_REQUESTED = '200m';
const DEFAULT_MEM_REQUESTED = '256Mi';
const DEFAULT_CPU_LIMIT = '500m';
const DEFAULT_MEM_LIMIT = '512Mi';

const JOB_TTL_SECONDS = 600;
const RUN_AS_USER = 1001;
const GVISOR_RUNTIME_CLASS = 'gvisor';
const CODE_MOUNT_PATH = '/app';
const CODE_FILE_NAME = 'code.py';
/**
 * Name of the Job container that runs the code, and so the one whose
 * termination status is the status of the execution.
 */
const CODE_CONTAINER_NAME = 'code-runner';
const VOLUME_NAME = 'code-volume';
const INVOCATION_ID_ANNOTATION = 'adk.agent.google.com/invocation-id';

/** File the generated code is written to inside a sandbox. */
const SCRIPT_FILENAME = 'script.py';
/** Command run inside a sandbox to execute the script. */
const RUN_COMMAND = 'python3 script.py';

/** The `BatchV1Api` operations the executor calls. */
export type GkeJobsApi = Pick<BatchV1Api, 'createNamespacedJob'>;

/** The `CoreV1Api` operations the executor calls. */
export type GkePodsApi = Pick<
  CoreV1Api,
  | 'createNamespacedConfigMap'
  | 'patchNamespacedConfigMap'
  | 'listNamespacedPod'
  | 'readNamespacedPodLog'
>;

/**
 * The Job watch endpoint the executor calls. `Watch` from
 * `@kubernetes/client-node` satisfies it.
 */
export interface GkeJobWatcher {
  /**
   * Streams events for `path` until the connection closes, then calls `done`.
   *
   * @return A controller that closes the connection when aborted.
   */
  watch(
    path: string,
    queryParams: Record<string, string | number | boolean | undefined>,
    callback: (phase: string, job: V1Job) => void,
    done: (err: unknown) => void,
  ): Promise<AbortController>;
}

/**
 * Pre-built Kubernetes clients. Supplying them skips kubeconfig resolution, so
 * the executor talks only to what is passed in.
 */
export interface GkeApiClients {
  /** Creates the Job. */
  jobs: GkeJobsApi;
  /** Creates and patches the ConfigMap, and reads the Pod and its log. */
  pods: GkePodsApi;
  /** Watches the Job until it reaches a terminal state. */
  watcher: GkeJobWatcher;
}

/** The execution backend used by {@link GkeCodeExecutor}. */
export type GkeExecutorType = 'job' | 'sandbox';

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
  /** Maximum time to wait for the code to finish. Default `300`. */
  timeoutSeconds?: number;
  /** The execution backend to use. Default `'job'`. */
  executorType?: GkeExecutorType;
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
  /** The Agent Sandbox router/gateway name. Sandbox mode only. */
  sandboxGatewayName?: string;
  /** The Agent Sandbox template. Default `'python-sandbox-template'`. */
  sandboxTemplate?: string;
  /**
   * Opens a connection to an Agent Sandbox. Defaults to the bundled
   * {@link AgentSandboxClient}. Sandbox mode only.
   */
  sandboxClientFactory?: SandboxClientFactory;
  /** Pre-built Kubernetes clients, used instead of loading a kubeconfig. */
  apiClients?: GkeApiClients;
}

/** Container resource sizing used to build the Job manifest. */
interface JobResourceConfig {
  image: string;
  cpuRequested: string;
  memRequested: string;
  cpuLimit: string;
  memLimit: string;
}

/** Everything one job-mode execution needs from `@kubernetes/client-node`. */
interface ResolvedClients extends GkeApiClients {
  /** Makes `patchNamespacedConfigMap` send a strategic merge patch. */
  strategicMergePatch: ConfigurationOptions;
}

/** A Job's terminal state, or `'timeout'` when the deadline passed first. */
type JobOutcome = 'succeeded' | 'failed' | 'timeout';

/** The Pod's log together with the status its code container exited with. */
interface PodOutput {
  logs: string;
  exitCode?: number;
}

/**
 * Returns whether `error` is a Kubernetes API error.
 *
 * Matched structurally rather than with `instanceof`, so the check still holds
 * when the caller and the client library resolve different copies of
 * `@kubernetes/client-node`.
 */
function isApiException(error: unknown): error is ApiException<unknown> {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'number' &&
    'body' in error &&
    'headers' in error
  );
}

/**
 * Extracts a human-readable reason from a Kubernetes API error.
 *
 * `ApiException` carries no `reason` of its own, unlike Python's client. The
 * reason lives in `body`, which is a parsed object for a JSON response and a
 * string otherwise, so the parse is guarded.
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
 * gVisor-sandboxed Pod.
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
          // The Pod runs model-generated code, so it must not receive a
          // credential for the cluster it is running in.
          automountServiceAccountToken: false,
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
          volumes: [{name: VOLUME_NAME, configMap: {name: configmapName}}],
          containers: [
            {
              name: CODE_CONTAINER_NAME,
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

/** Reads the terminal state a Job reports, if it has reached one. */
function readJobOutcome(job: V1Job): JobOutcome | undefined {
  if (job.status?.succeeded) {
    return 'succeeded';
  }
  if (job.status?.failed) {
    return 'failed';
  }
  return undefined;
}

/** Whole seconds left until `deadline`, rounded up. */
function secondsUntil(deadline: number): number {
  return Math.ceil((deadline - Date.now()) / 1000);
}

/**
 * Reads the status the code container of `pod` exited with.
 *
 * @return The exit status, or undefined when the container is absent from the
 *   Pod's status or has not reached a terminated state.
 */
function getContainerExitCode(pod: V1Pod): number | undefined {
  for (const status of pod.status?.containerStatuses ?? []) {
    if (status.name !== CODE_CONTAINER_NAME) {
      continue;
    }
    return status.state?.terminated?.exitCode;
  }
  return undefined;
}

/**
 * Retrieves the log and exit status of the Pod created by the given Job.
 *
 * Both come from a single Pod lookup, because the status a container
 * terminated with is only available for as long as the Pod its log comes from.
 *
 * @throws Error if no Pod can be found for the Job.
 */
async function getPodOutput(
  pods: GkePodsApi,
  namespace: string,
  jobName: string,
): Promise<PodOutput> {
  const podList = await pods.listNamespacedPod({
    namespace,
    labelSelector: `job-name=${jobName}`,
    limit: 1,
  });
  const pod = podList.items[0];
  const podName = pod?.metadata?.name;
  if (!podName) {
    throw new Error(
      `Could not find Pod for Job '${jobName}' to retrieve logs.`,
    );
  }
  const logs = await pods.readNamespacedPodLog({name: podName, namespace});
  return {logs, exitCode: getContainerExitCode(pod)};
}

/**
 * Loads cluster credentials in the order an explicit path, the in-cluster
 * service account, then the local default kubeconfig.
 */
function loadKubeConfig(
  KubeConfigClass: typeof import('@kubernetes/client-node').KubeConfig,
  options: GkeCodeExecutorOptions,
): InstanceType<typeof KubeConfigClass> {
  const kc = new KubeConfigClass();
  if (options.kubeconfigPath) {
    try {
      kc.loadFromFile(options.kubeconfigPath);
      if (options.kubeconfigContext) {
        kc.setCurrentContext(options.kubeconfigContext);
      }
      return kc;
    } catch (err) {
      throw new Error(
        'Failed to configure Kubernetes client from provided path.',
        {cause: err},
      );
    }
  }
  try {
    kc.loadFromCluster();
    return kc;
  } catch (clusterErr) {
    logger.debug(
      'In-cluster config not found. Falling back to default local kubeconfig.',
      clusterErr,
    );
  }
  try {
    kc.loadFromDefault();
    return kc;
  } catch (err) {
    throw new Error('Failed to find any valid Kubernetes configuration.', {
      cause: err,
    });
  }
}

/**
 * Loads `@kubernetes/client-node` and builds everything job mode needs from it.
 * Injected clients are used as they are; only the patch options always come
 * from the package, because they carry the strategic-merge content type the
 * generated client does not default to.
 */
async function resolveClients(
  options: GkeCodeExecutorOptions,
): Promise<ResolvedClients> {
  const k8s = await loadOptionalPeer(
    {packageName: '@kubernetes/client-node', feature: 'GkeCodeExecutor'},
    () => import('@kubernetes/client-node'),
  );
  const strategicMergePatch = k8s.setHeaderOptions(
    'Content-Type',
    k8s.PatchStrategy.StrategicMergePatch,
  );
  if (options.apiClients) {
    return {...options.apiClients, strategicMergePatch};
  }
  const kc = loadKubeConfig(k8s.KubeConfig, options);
  return {
    jobs: kc.makeApiClient(k8s.BatchV1Api),
    pods: kc.makeApiClient(k8s.CoreV1Api),
    watcher: new k8s.Watch(kc),
    strategicMergePatch,
  };
}

/** Builds a failure {@link CodeExecutionResult} with the given stderr message. */
function errorResult(stderr: string): CodeExecutionResult {
  return {stdout: '', stderr, outputFiles: []};
}

/**
 * Returns whether `error` should be treated as a sandbox execution timeout.
 *
 * Covers both the explicit {@link SandboxTimeoutError} and standard Node
 * timeouts, such as `AbortSignal.timeout`, whose error is named
 * `'TimeoutError'`.
 */
function isTimeoutError(error: unknown): error is Error {
  return (
    error instanceof SandboxTimeoutError ||
    (error instanceof Error && error.name === 'TimeoutError')
  );
}

/**
 * Releases `sandbox` if it was opened, logging and swallowing any error so
 * cleanup never masks the primary result.
 */
async function closeSandboxQuietly(
  sandbox: SandboxClient | undefined,
): Promise<void> {
  if (!sandbox) {
    return;
  }
  try {
    await sandbox.close();
  } catch (closeErr) {
    logger.error('Failed to close sandbox', closeErr);
  }
}

/**
 * Executes code in a dedicated Pod on GKE, in one of two modes that do not
 * provide the same isolation.
 *
 * Job mode, the default, creates a Kubernetes Job per execution. The code is
 * mounted from a ConfigMap, the Pod requests the gVisor runtime, and it runs
 * under a strict security context with CPU and memory limits. Completed Jobs
 * and Pods are garbage-collected by the TTL controller.
 *
 * Sandbox mode runs the code through the GKE Agent Sandbox infrastructure. The
 * Pod comes from a sandbox template already installed in the cluster, so its
 * runtime class and security context come from that template and not from this
 * executor. It needs the agent-sandbox controller, a sandbox template and a
 * sandbox router and gateway to be deployed in the cluster.
 *
 * `@kubernetes/client-node` is an optional peer dependency. It is loaded on the
 * first execution, not in the constructor.
 *
 * Job mode needs a ServiceAccount whose Role grants:
 * - configmaps: `create`, `delete`, `get`, `patch` (core API group)
 * - jobs: `get`, `list`, `watch`, `create`, `delete` (batch API group)
 * - pods and pods/log: `get`, `list` (core API group)
 */
@experimental
export class GkeCodeExecutor extends BaseCodeExecutor {
  /** Namespace the Job, ConfigMap and sandbox are created in. */
  readonly namespace: string;
  /** Container image job mode runs the code in. */
  readonly image: string;
  /** Maximum time to wait for the code to finish. */
  timeoutSeconds: number;
  /** The execution backend in use. */
  readonly executorType: GkeExecutorType;
  /** Requested CPU for the code container. */
  readonly cpuRequested: string;
  /** Requested memory for the code container. */
  readonly memRequested: string;
  /** CPU limit for the code container. */
  readonly cpuLimit: string;
  /** Memory limit for the code container. */
  readonly memLimit: string;
  /** Explicit kubeconfig file path, when one was given. */
  readonly kubeconfigPath?: string;
  /** Explicit kubeconfig context, when one was given. */
  readonly kubeconfigContext?: string;
  /** Agent Sandbox router/gateway name, when one was given. */
  readonly sandboxGatewayName?: string;
  /** Agent Sandbox template used by sandbox mode. */
  readonly sandboxTemplate: string;
  /** Opens a sandbox in sandbox mode. */
  readonly sandboxClientFactory: SandboxClientFactory;

  private readonly options: GkeCodeExecutorOptions;
  private clientsPromise?: Promise<ResolvedClients>;

  constructor(options: GkeCodeExecutorOptions = {}) {
    super();
    this.options = options;
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.image = options.image ?? DEFAULT_IMAGE;
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.executorType = options.executorType ?? 'job';
    this.cpuRequested = options.cpuRequested ?? DEFAULT_CPU_REQUESTED;
    this.memRequested = options.memRequested ?? DEFAULT_MEM_REQUESTED;
    this.cpuLimit = options.cpuLimit ?? DEFAULT_CPU_LIMIT;
    this.memLimit = options.memLimit ?? DEFAULT_MEM_LIMIT;
    this.kubeconfigPath = options.kubeconfigPath;
    this.kubeconfigContext = options.kubeconfigContext;
    this.sandboxGatewayName = options.sandboxGatewayName;
    this.sandboxTemplate = options.sandboxTemplate ?? DEFAULT_SANDBOX_TEMPLATE;
    this.sandboxClientFactory =
      options.sandboxClientFactory ?? defaultSandboxClientFactory;
  }

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const {code} = params.codeExecutionInput;
    if (this.executorType === 'sandbox') {
      return this.executeInSandbox(code);
    }
    return this.executeAsJob(code, params.invocationContext.invocationId);
  }

  /**
   * Resolves the Kubernetes clients once. The promise is memoized rather than
   * the clients, so concurrent executions share one load.
   */
  private getClients(): Promise<ResolvedClients> {
    this.clientsPromise ??= resolveClients(this.options);
    return this.clientsPromise;
  }

  /**
   * Runs `code` as a Kubernetes Job. Never throws: API errors, Job failures and
   * timeouts all come back as a `stderr` result.
   */
  private async executeAsJob(
    code: string,
    invocationId: string,
  ): Promise<CodeExecutionResult> {
    const jobName = `adk-exec-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const configmapName = `code-src-${jobName}`;

    try {
      const clients = await this.getClients();
      await this.createCodeConfigMap(clients, configmapName, code);
      const createdJob = await clients.jobs.createNamespacedJob({
        namespace: this.namespace,
        body: buildJobManifest(jobName, configmapName, invocationId, this),
      });
      await this.addOwnerReference(clients, createdJob, configmapName);

      logger.debug(
        `Submitted Job '${jobName}' to namespace '${this.namespace}'.`,
      );
      const outcome = await this.waitForOutcome(clients, jobName);
      const {logs, exitCode} = await getPodOutput(
        clients.pods,
        this.namespace,
        jobName,
      );
      switch (outcome) {
        case 'succeeded':
          return {
            stdout: logs,
            stderr: '',
            outputFiles: [],
            // The Job reports only success or failure, so the status comes
            // from the Pod. When the Pod reports no terminated container the
            // status is narrowed to what the Job's outcome implies.
            exitCode: exitCode ?? 0,
          };
        case 'failed':
          return {
            stdout: '',
            stderr: `Job failed. Logs:\n${logs}`,
            outputFiles: [],
            exitCode: exitCode ?? 1,
          };
        case 'timeout':
          return errorResult(
            `Executor timed out: Job '${jobName}' did not complete within ` +
              `${this.timeoutSeconds}s.\n\nPod Logs:\n${logs}`,
          );
      }
    } catch (err) {
      if (isApiException(err)) {
        return errorResult(`Kubernetes API error: ${getApiErrorReason(err)}`);
      }
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`An unexpected executor error occurred: ${message}`);
    }
  }

  /**
   * Waits for the Job to reach a terminal state, within `timeoutSeconds`.
   *
   * A single watch connection is capped at 30 seconds by the client library, so
   * a connection that closes with no terminal state seen is re-established
   * until this executor's own deadline passes.
   */
  private async waitForOutcome(
    clients: ResolvedClients,
    jobName: string,
  ): Promise<JobOutcome> {
    const deadline = Date.now() + this.timeoutSeconds * 1000;
    for (
      let remaining = secondsUntil(deadline);
      remaining > 0;
      remaining = secondsUntil(deadline)
    ) {
      const outcome = await this.watchOnce(clients.watcher, jobName, remaining);
      if (outcome) {
        logger.debug(`Job '${jobName}' ${outcome}.`);
        return outcome;
      }
    }
    logger.debug(`Job '${jobName}' timed out.`);
    return 'timeout';
  }

  /**
   * Watches the Job over one connection.
   *
   * @return The terminal state the Job reached, or undefined when the
   *   connection closed before it reached one.
   */
  private async watchOnce(
    watcher: GkeJobWatcher,
    jobName: string,
    timeoutSeconds: number,
  ): Promise<JobOutcome | undefined> {
    let outcome: JobOutcome | undefined;
    let stop = () => {};
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });

    const controller = await watcher.watch(
      `/apis/batch/v1/namespaces/${this.namespace}/jobs`,
      {fieldSelector: `metadata.name=${jobName}`, timeoutSeconds},
      (_phase, job) => {
        outcome ??= readJobOutcome(job);
        if (outcome) {
          stop();
        }
      },
      stop,
    );
    try {
      await stopped;
    } finally {
      controller.abort();
    }
    return outcome;
  }

  /** Creates the ConfigMap holding the code, mounted into the Pod. */
  private async createCodeConfigMap(
    clients: ResolvedClients,
    name: string,
    code: string,
  ): Promise<void> {
    const body: V1ConfigMap = {
      metadata: {name},
      data: {[CODE_FILE_NAME]: code},
    };
    await clients.pods.createNamespacedConfigMap({
      namespace: this.namespace,
      body,
    });
  }

  /**
   * Patches the ConfigMap so it is owned by the Job and garbage-collected with
   * it. A failed patch is not fatal: the code is already running, so the
   * executor warns and continues.
   */
  private async addOwnerReference(
    clients: ResolvedClients,
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

    try {
      await clients.pods.patchNamespacedConfigMap(
        {
          name: configmapName,
          namespace: this.namespace,
          body: {metadata: {ownerReferences: [ownerReference]}},
        },
        clients.strategicMergePatch,
      );
      logger.debug(
        `Set Job '${ownerReference.name}' as owner of ConfigMap '${configmapName}'.`,
      );
    } catch (err) {
      if (!isApiException(err)) {
        throw err;
      }
      logger.warn(
        `Failed to set ownerReference on ConfigMap '${configmapName}'. ` +
          `Manual cleanup is required. Reason: ${getApiErrorReason(err)}`,
      );
    }
  }

  /**
   * Runs `code` through an Agent Sandbox. Unlike job mode this rethrows
   * infrastructure and unknown errors, and returns a result only for timeouts,
   * matching adk-python.
   */
  private async executeInSandbox(code: string): Promise<CodeExecutionResult> {
    let sandbox: SandboxClient | undefined;
    try {
      sandbox = await this.sandboxClientFactory({
        namespace: this.namespace,
        templateName: this.sandboxTemplate,
        gatewayName: this.sandboxGatewayName,
      });
      await sandbox.write(SCRIPT_FILENAME, code);
      const result = await sandbox.run(RUN_COMMAND);
      await closeSandboxQuietly(sandbox);
      return {
        stdout: result.stdout,
        stderr: result.stderr ?? '',
        outputFiles: [],
      };
    } catch (err) {
      await closeSandboxQuietly(sandbox);
      if (isTimeoutError(err)) {
        logger.error('Sandbox timed out', err);
        // Returning a result instead of throwing lets the agent handle the
        // failure itself.
        return errorResult(`Sandbox timed out: ${err.message}`);
      }
      if (err instanceof SandboxInfrastructureError) {
        logger.error('Sandbox failed to initialize or find its gateway', err);
        throw new SandboxInfrastructureError(
          `Sandbox infrastructure error: ${err.message}`,
        );
      }
      logger.error('Sandbox execution failed', err);
      throw err;
    }
  }
}
