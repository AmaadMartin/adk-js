/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import dotenv from 'dotenv';
import {exec, spawn, SpawnOptions} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {AgentFileOptions, AgentLoader} from '../../utils/agent_loader.js';
import {
  isFileExists,
  loadFileData,
  saveToFile,
  tryToFindFileRecursively,
} from '../../utils/file_utils.js';

export const execAsync = promisify(exec);
export const spawnAsync = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, options);
    child.on('close', (code: number) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
    child.on('error', reject);
  });
};

export const REQUIRED_NPM_PACKAGES = ['@google/adk'];

export interface CreateDockerFileContentOptions {
  appName?: string;
  project: string;
  region?: string;
  port: number;
  withUi: boolean;
  logLevel: string;
  allowOrigins?: string;
  sessionServiceUri?: string;
  artifactServiceUri?: string;
  otelToCloud?: boolean;
  a2a?: boolean;
}

export interface BaseDeployOptions extends CreateDockerFileContentOptions {
  agentPath: string;
  tempFolder: string;
  adkVersion: string;
  agentFileLoadOptions?: AgentFileOptions;
}

export function createDockerFileContent(
  options: CreateDockerFileContentOptions,
): string {
  const adkCommand = options.withUi ? 'web' : 'api_server';
  const adkServerOptions = [`--port=${options.port}`, '--host=0.0.0.0'];

  if (options.logLevel) {
    adkServerOptions.push(`--log_level=${options.logLevel}`);
  }

  if (options.allowOrigins) {
    adkServerOptions.push(`--allow_origins=${options.allowOrigins}`);
  }

  if (options.artifactServiceUri) {
    adkServerOptions.push(
      `--artifact_service_uri=${options.artifactServiceUri}`,
    );
  }

  if (options.sessionServiceUri) {
    adkServerOptions.push(`--session_service_uri=${options.sessionServiceUri}`);
  }

  if (options.otelToCloud) {
    adkServerOptions.push('--otel_to_cloud');
  }

  if (options.a2a) {
    adkServerOptions.push('--a2a');
  }

  return `
FROM node:lts-alpine
WORKDIR /app

# Create a non-root user
RUN adduser --disabled-password --gecos "" myuser

# Switch to the non-root user
USER myuser

# Set up environment variables - Start
ENV PATH="/home/myuser/.local/bin:$PATH"
ENV GOOGLE_GENAI_USE_VERTEXAI=1
ENV GOOGLE_CLOUD_PROJECT=${options.project}
ENV GOOGLE_CLOUD_LOCATION=${options.region}
# Set up environment variables - End

# Copy application files
COPY --chown=myuser:myuser "agents/${options.appName}/" "/app/agents/${
    options.appName
  }/"
COPY --chown=myuser:myuser "package.json" "/app/package.json"
COPY --chown=myuser:myuser "package-lock.json" "/app/package-lock.json"
COPY --chown=myuser:myuser "node_modules" "/app/node_modules"
# Copy application files

# Install Agent Deps - Start
RUN npm install @google/adk-devtools@latest
RUN npm install --production
# Install Agent Deps - End

EXPOSE ${options.port}

CMD npx adk ${adkCommand} /app/agents/${options.appName} ${adkServerOptions.join(
    ' ',
  )}`;
}

export async function createDockerFile(
  targetFolder: string,
  options: CreateDockerFileContentOptions,
) {
  const dockerFilePath = path.join(targetFolder, 'Dockerfile');
  await saveToFile(dockerFilePath, createDockerFileContent(options));

  console.info('Creating Dockerfile complete:', dockerFilePath);
}

export async function copyAgentFiles(
  agentLoader: AgentLoader,
  targetPath: string,
): Promise<void> {
  const agentNames = await agentLoader.listAgents();

  for (const agentName of agentNames) {
    const agentFile = await agentLoader.getAgentFile(agentName);
    const fileName = path.parse(agentFile.getFilePath()).base;

    await fs.cp(agentFile.getFilePath(), path.join(targetPath, fileName));
  }
}

export async function createPackageJson(
  sourceFolder: string,
  targetFolder: string,
) {
  const packageJsonPath = await tryToFindFileRecursively(
    sourceFolder,
    'package.json',
    3,
  );
  const packageJson = await loadFileData<{
    dependencies: Record<string, string>;
  }>(packageJsonPath);
  if (!packageJson || !packageJson.dependencies) {
    throw new Error(
      `No dependencies found in package.json: ${packageJsonPath}`,
    );
  }
  for (const requiredDep of REQUIRED_NPM_PACKAGES) {
    if (!(requiredDep in packageJson.dependencies)) {
      throw new Error(
        `Package "${requiredDep}" is required but not found in package.json: ${
          packageJsonPath
        }`,
      );
    }
  }

  const targetPackageJsonPath = path.join(targetFolder, 'package.json');

  await Promise.all([
    fs.mkdir(path.join(targetFolder, 'node_modules')),
    saveToFile(path.join(targetFolder, 'package-lock.json'), ''),
    saveToFile(targetPackageJsonPath, {
      dependencies: packageJson.dependencies,
    }),
  ]);
}

export async function resolveDefaultFromGcloudConfig(
  property: string,
): Promise<string | undefined> {
  const {stdout} = await execAsync('gcloud config get-value ' + property);
  return stdout.trim();
}

/** Deploy configuration contributed by an agent's `.env` file. */
export interface AgentEnvConfig {
  /** Variables to forward to the deployed agent, in file order. */
  envVars: Record<string, string>;
  /** `GOOGLE_CLOUD_PROJECT`, unless `--project` overrode it. */
  project?: string;
  /** `GOOGLE_CLOUD_LOCATION`, unless `--region` overrode it. */
  region?: string;
}

/**
 * Returns `envValue` when it can serve as the fall-back for `--<label>`, i.e.
 * when it is non-empty and the flag did not override it, and reports which of
 * the two won.
 */
function resolveEnvFallback(
  envFile: string,
  key: string,
  label: string,
  envValue: string | undefined,
  flagValue: string | undefined,
): string | undefined {
  if (!envValue) {
    return undefined;
  }
  if (flagValue) {
    console.warn(
      `Ignoring ${key} in .env as \`--${label}\` was explicitly passed and takes precedence`,
    );
    return undefined;
  }
  console.info(`${label}='${envValue}' set by ${key} in ${envFile}`);
  return envValue;
}

/**
 * Reads `<agentDir>/.env` and returns the variables to forward to the deployed
 * agent, along with the project/region it offers as flag fall-backs.
 *
 * `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` are removed from the
 * forwarded set: the resolved values are already written into the generated
 * Dockerfile, and re-forwarding a stale copy would override them at runtime.
 *
 * Returns empty results when the file does not exist. Variable values are never
 * logged.
 */
export async function loadAgentEnvConfig(
  agentDir: string,
  options: {project?: string; region?: string},
): Promise<AgentEnvConfig> {
  const envFile = path.join(agentDir, '.env');
  if (!(await isFileExists(envFile))) {
    return {envVars: {}};
  }

  console.info(`Reading environment variables from ${envFile}`);
  const {
    GOOGLE_CLOUD_PROJECT: envProject,
    GOOGLE_CLOUD_LOCATION: envRegion,
    ...envVars
  } = dotenv.parse(await fs.readFile(envFile, {encoding: 'utf-8'}));

  const project = resolveEnvFallback(
    envFile,
    'GOOGLE_CLOUD_PROJECT',
    'project',
    envProject,
    options.project,
  );
  const region = resolveEnvFallback(
    envFile,
    'GOOGLE_CLOUD_LOCATION',
    'region',
    envRegion,
    options.region,
  );

  const forwarded = Object.keys(envVars);
  if (forwarded.length) {
    console.info(
      `Forwarding ${forwarded.length} environment variable(s) from ${
        envFile
      }: ${forwarded.join(', ')}`,
    );
  }

  return {envVars, project, region};
}

/**
 * Formats env vars as a single gcloud dict-flag value. gcloud splits pairs on
 * `,` unless the value opens with `^DELIM^`, where DELIM is any character
 * sequence absent from the payload; see
 * https://cloud.google.com/sdk/gcloud/reference/topic/escaping
 */
export function formatGcloudEnvVarsArg(
  envVars: Record<string, string>,
): string {
  const entries = Object.entries(envVars).map(
    ([name, value]) => `${name}=${value}`,
  );
  // The escaped form below is valid for any payload; the plain form is kept
  // for the common case so the emitted gcloud command stays readable.
  if (entries.every((entry) => !entry.includes(','))) {
    return entries.join(',');
  }

  // A delimiter longer than the payload cannot occur in it, so this terminates.
  let delimiter = '@';
  while (entries.some((entry) => entry.includes(delimiter))) {
    delimiter += '@';
  }
  return `^${delimiter}^${entries.join(delimiter)}`;
}
