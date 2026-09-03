/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';

import type {
  BatchV1Api,
  ConfigurationOptions,
  CoreV1Api,
  V1ConfigMap,
  V1Job,
  V1OwnerReference,
} from '@kubernetes/client-node';

import {formatError} from '../utils/error_utils.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {defaultSandboxClientFactory} from './agent_sandbox_client.js';
import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {CodeExecutionResult} from './code_execution_utils.js';
import {
  buildJobManifest,
  CODE_FILE_NAME,
  getPodOutput,
  readJobOutcome,
  type JobOutcome,
} from './gke_job.js';
import {
  getApiErrorReason,
  isApiException,
  isWatchHttpError,
} from './k8s_error_utils.js';
import {
  DEFAULT_SANDBOX_TEMPLATE,
  isAbortTimeout,
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

/** Everything one job-mode execution needs from `@kubernetes/client-node`. */
interface ResolvedClients extends GkeApiClients {
  /** Makes `patchNamespacedConfigMap` send a strategic merge patch. */
  strategicMergePatch: ConfigurationOptions;
}

/** Whole seconds left until `deadline`, rounded up. */
function secondsUntil(deadline: number): number {
  return Math.ceil((deadline - Date.now()) / 1000);
}

/** The subset of the options that says where the clients come from. */
type ClientSource = Pick<
  GkeCodeExecutorOptions,
  'apiClients' | 'kubeconfigPath' | 'kubeconfigContext'
>;

/**
 * Loads cluster credentials in the order an explicit path, the in-cluster
 * service account, then the local default kubeconfig.
 */
function loadKubeConfig(
  KubeConfigClass: typeof import('@kubernetes/client-node').KubeConfig,
  options: ClientSource,
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
async function resolveClients(options: ClientSource): Promise<ResolvedClients> {
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
 * Returns whether `error` should be treated as an execution timeout.
 *
 * Covers both the explicit {@link SandboxTimeoutError} and standard Node
 * timeouts, such as `AbortSignal.timeout`, whose error is named
 * `'TimeoutError'`. `Watch` reports its own connection cap as the latter.
 */
function isTimeoutError(error: unknown): error is Error {
  return error instanceof SandboxTimeoutError || isAbortTimeout(error);
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

  private readonly apiClients?: GkeApiClients;
  private clientsPromise?: Promise<ResolvedClients>;

  constructor(options: GkeCodeExecutorOptions = {}) {
    super();
    this.apiClients = options.apiClients;
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
    this.clientsPromise ??= resolveClients({
      apiClients: this.apiClients,
      kubeconfigPath: this.kubeconfigPath,
      kubeconfigContext: this.kubeconfigContext,
    });
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
      if (isWatchHttpError(err)) {
        return errorResult(`Kubernetes API error: ${err.message}`);
      }
      return errorResult(
        `An unexpected executor error occurred: ${formatError(err)}`,
      );
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
   * `Watch` ends a connection three ways, and only two of them are worth
   * retrying. A clean close and the client's own connection cap both mean the
   * Job is simply still running. Anything else -- a 403 from a ServiceAccount
   * without `watch` on `batch/jobs`, a 5xx, a refused connection -- is a real
   * failure that returns in milliseconds, so retrying it spins against the API
   * server and hides the cause behind a timeout. Those are thrown instead, and
   * reported the way adk-python reports them.
   *
   * @return The terminal state the Job reached, or undefined when the
   *   connection closed before it reached one.
   * @throws The error `Watch` ended the connection with, when it failed.
   */
  private async watchOnce(
    watcher: GkeJobWatcher,
    jobName: string,
    timeoutSeconds: number,
  ): Promise<JobOutcome | undefined> {
    let outcome: JobOutcome | undefined;
    let failure: unknown;
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
      (err) => {
        failure = err;
        stop();
      },
    );
    try {
      await stopped;
    } finally {
      controller.abort();
    }
    if (!outcome && failure && !isTimeoutError(failure)) {
      throw failure;
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
      return {
        stdout: result.stdout,
        stderr: result.stderr ?? '',
        outputFiles: [],
        exitCode: result.exitCode,
      };
    } catch (err) {
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
    } finally {
      await closeSandboxQuietly(sandbox);
    }
  }
}
