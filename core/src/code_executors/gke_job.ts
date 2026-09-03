/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Kubernetes Job that job-mode execution runs in: the hardened manifest,
 * the terminal state the Job reports, and the log and exit status of its Pod.
 */

import type {V1Job, V1Pod} from '@kubernetes/client-node';

import type {GkePodsApi} from './gke_code_executor.js';

const JOB_TTL_SECONDS = 600;
const RUN_AS_USER = 1001;
const GVISOR_RUNTIME_CLASS = 'gvisor';
const CODE_MOUNT_PATH = '/app';
/** Name the code is mounted under inside the Pod. */
export const CODE_FILE_NAME = 'code.py';
/**
 * Name of the Job container that runs the code, and so the one whose
 * termination status is the status of the execution.
 */
const CODE_CONTAINER_NAME = 'code-runner';
const VOLUME_NAME = 'code-volume';
const INVOCATION_ID_ANNOTATION = 'adk.agent.google.com/invocation-id';

/** Container resource sizing used to build the Job manifest. */
export interface JobResourceConfig {
  image: string;
  cpuRequested: string;
  memRequested: string;
  cpuLimit: string;
  memLimit: string;
}

/** A Job's terminal state, or `'timeout'` when the deadline passed first. */
export type JobOutcome = 'succeeded' | 'failed' | 'timeout';

/** The Pod's log together with the status its code container exited with. */
export interface PodOutput {
  logs: string;
  exitCode?: number;
}

/**
 * Builds the hardened {@link V1Job} manifest that runs the code in a
 * gVisor-sandboxed Pod.
 */
export function buildJobManifest(
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
export function readJobOutcome(job: V1Job): JobOutcome | undefined {
  if (job.status?.succeeded) {
    return 'succeeded';
  }
  if (job.status?.failed) {
    return 'failed';
  }
  return undefined;
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
export async function getPodOutput(
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
