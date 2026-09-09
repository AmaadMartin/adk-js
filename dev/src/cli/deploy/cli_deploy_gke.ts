/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs/promises';
import * as path from 'node:path';

import yaml from 'js-yaml';

import {AgentLoader} from '../../utils/agent_loader.js';
import {
  createTempDir,
  isFile,
  isFolderExists,
  saveToFile,
} from '../../utils/file_utils.js';
import {
  BaseDeployOptions,
  assertMatches,
  copyAgentFiles,
  createDockerFile,
  createPackageJson,
  resolveRequiredGcloudDefault,
  spawnAsync,
} from './deploy_utils.js';

/** Kubernetes Service types the deploy command can create. */
export const GKE_SERVICE_TYPES = ['ClusterIP', 'LoadBalancer'] as const;

export type GkeServiceType = (typeof GKE_SERVICE_TYPES)[number];

export interface DeployToGkeOptions extends BaseDeployOptions {
  clusterName: string;
  serviceName: string;
  serviceType: GkeServiceType;
}

export interface DeploymentManifestOptions {
  serviceName: string;
  image: string;
  port: number;
  adkVersion: string;
  serviceType: GkeServiceType;
}

/** Port the generated Service listens on, as in adk-python. */
const SERVICE_PORT = 80;

const MIN_PORT = 1;
const MAX_PORT = 65535;

// A Service name must be an RFC 1035 label and a label value must match the
// Kubernetes label grammar, each bounded to 63 characters by the leading
// lookahead. `yaml.dump` already keeps any value inside the document it
// belongs to, so these patterns are not the escaping mechanism: they turn a
// name the API server would reject into a local error naming the offending
// value.
const RFC_1035_LABEL_RE = /^(?=.{1,63}$)[a-z]([-a-z0-9]*[a-z0-9])?$/;
const LABEL_VALUE_RE = /^(?=.{1,63}$)[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `Invalid port ${port}: must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
    );
  }
}

/**
 * Narrows a command-line string to a {@link GkeServiceType}.
 *
 * @throws Error if the value is not a supported Service type.
 */
export function parseGkeServiceType(value: string): GkeServiceType {
  const serviceType = GKE_SERVICE_TYPES.find((known) => known === value);
  if (!serviceType) {
    throw new Error(
      `Invalid service type ${JSON.stringify(value)}: must be one of ${GKE_SERVICE_TYPES.join(', ')}.`,
    );
  }

  return serviceType;
}

/**
 * Builds the `Deployment` and `Service` manifest applied to the cluster.
 *
 * The documents are serialized by `yaml.dump` from plain objects, so an
 * interpolated name, image tag or version cannot terminate a value and inject
 * further YAML.
 */
export function createDeploymentManifest(
  options: DeploymentManifestOptions,
): string {
  assertMatches(
    options.serviceName,
    'serviceName',
    RFC_1035_LABEL_RE,
    `must match ${RFC_1035_LABEL_RE} to be a valid Kubernetes resource name.`,
  );
  assertMatches(
    options.adkVersion,
    'adkVersion',
    LABEL_VALUE_RE,
    `must match ${LABEL_VALUE_RE} to be a valid Kubernetes label value.`,
  );
  assertPort(options.port);

  const labels = {
    'app.kubernetes.io/name': 'adk-agent',
    'app.kubernetes.io/version': options.adkVersion,
    'app.kubernetes.io/instance': options.serviceName,
    'app.kubernetes.io/managed-by': 'adk-cli',
  };

  const deployment = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {name: options.serviceName, labels},
    spec: {
      replicas: 1,
      selector: {matchLabels: {app: options.serviceName}},
      template: {
        metadata: {labels: {app: options.serviceName, ...labels}},
        spec: {
          containers: [
            {
              name: options.serviceName,
              image: options.image,
              ports: [{containerPort: options.port}],
            },
          ],
        },
      },
    },
  };

  const service = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {name: options.serviceName},
    spec: {
      type: options.serviceType,
      selector: {app: options.serviceName},
      ports: [{port: SERVICE_PORT, targetPort: options.port}],
    },
  };

  return `${yaml.dump(deployment)}---\n${yaml.dump(service)}`;
}

/** Deploys an agent to a Google Kubernetes Engine cluster. */
export async function deployToGke(options: DeployToGkeOptions) {
  if (!options.clusterName) {
    throw new Error(
      'Cluster name is not specified. Please specify the GKE cluster with the --cluster_name option.',
    );
  }

  options.project = await resolveRequiredGcloudDefault(
    options.project,
    'project',
    'project',
  );
  // compute/region is the gcloud property for GKE, as run/region is for
  // Cloud Run.
  const region = await resolveRequiredGcloudDefault(
    options.region,
    'compute/region',
    'region',
  );
  options.region = region;

  const agentLoader = new AgentLoader(
    options.agentPath,
    options.agentFileLoadOptions,
  );

  const isFileProvided = await isFile(options.agentPath);
  const agentDir = isFileProvided
    ? path.dirname(options.agentPath)
    : options.agentPath;
  const appName =
    options.appName ||
    (isFileProvided
      ? path.parse(options.agentPath).name
      : path.basename(options.agentPath));

  console.info('Starting deployment to GKE...');
  console.info('  Project:', options.project);
  console.info('  Region:', options.region);
  console.info('  Cluster:', options.clusterName);

  const tempFolder =
    options.tempFolder ?? (await createTempDir('gke_deploy_src'));

  if (options.tempFolder && (await isFolderExists(tempFolder))) {
    console.info('Cleaning up existing temporary files...');
    await fs.rm(tempFolder, {recursive: true, force: true});
  }

  const image = `gcr.io/${options.project}/${options.serviceName}`;

  try {
    await fs.mkdir(tempFolder, {recursive: true});

    // Built before the image so an invalid service name, version or port
    // fails in seconds instead of after a multi-minute Cloud Build.
    const manifest = createDeploymentManifest({
      serviceName: options.serviceName,
      image,
      port: options.port,
      adkVersion: options.adkVersion,
      serviceType: options.serviceType,
    });

    console.info('Copying agent source files...');
    await copyAgentFiles(agentLoader, path.join(tempFolder, 'agents', appName));

    console.info('Creating package.json...');
    await createPackageJson(agentDir, tempFolder);

    console.info('Creating Dockerfile...');
    await createDockerFile(tempFolder, {
      appName,
      project: options.project,
      region: options.region,
      port: options.port,
      withUi: options.withUi,
      logLevel: options.logLevel,
      allowOrigins: options.allowOrigins,
      sessionServiceUri: options.sessionServiceUri,
      artifactServiceUri: options.artifactServiceUri,
      otelToCloud: options.otelToCloud,
      a2a: options.a2a,
    });

    console.info(
      `Building and pushing container image to ${image} using Cloud Build...`,
    );
    await spawnAsync(
      'gcloud',
      [
        'builds',
        'submit',
        '--tag',
        image,
        '--verbosity',
        options.logLevel.toLowerCase(),
        tempFolder,
      ],
      {stdio: 'inherit'},
    );

    console.info('Creating Kubernetes deployment manifest...');
    const manifestPath = path.join(tempFolder, 'deployment.yaml');
    await saveToFile(manifestPath, manifest);

    console.info('Getting cluster credentials...');
    await spawnAsync(
      'gcloud',
      [
        'container',
        'clusters',
        'get-credentials',
        options.clusterName,
        '--region',
        region,
        '--project',
        options.project,
      ],
      {stdio: 'inherit'},
    );

    // The manifest file, not the staging folder adk-python applies: the
    // folder also holds package.json and package-lock.json, which kubectl
    // reads as manifests and rejects.
    console.info('Applying Kubernetes manifest...');
    await spawnAsync('kubectl', ['apply', '-f', manifestPath], {
      stdio: 'inherit',
    });

    console.info(
      `\x1b[32mSuccessfully deployed to GKE cluster ${options.clusterName}.\x1b[0m`,
    );
    if (options.serviceType === 'ClusterIP') {
      console.info(
        'The service is only reachable from within the cluster. To access it locally, run:\n' +
          `  kubectl port-forward svc/${options.serviceName} ${options.port}:${options.port}\n\n` +
          'To expose the service externally, re-deploy with --service_type=LoadBalancer.',
      );
    }
  } catch (e: unknown) {
    console.error(
      '\x1b[31mFailed to deploy to GKE:',
      (e as Error).message,
      '\x1b[0m',
    );
    throw e;
  } finally {
    console.info('Cleaning up temporary files...');
    await fs.rm(tempFolder, {recursive: true, force: true});
    await agentLoader.disposeAll();
    console.info('Temporary files cleaned up.');
  }
}
