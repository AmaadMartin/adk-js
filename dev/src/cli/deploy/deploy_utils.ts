/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import dotenv from 'dotenv';
import type {SpawnOptions} from 'node:child_process';
import {exec, spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {promisify} from 'node:util';
import type {AgentFileOptions, AgentLoader} from '../../utils/agent_loader.js';
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

/**
 * Base image for the generated Dockerfile.
 *
 * Pinned to an explicit Node major instead of the floating `node:lts-alpine`
 * tag. `lts` re-points to the next Node LTS line when it is promoted, so an
 * unchanged agent rebuilt later would move to a Node major that this SDK was
 * never exercised against, with no diff to show for it. Bump this deliberately
 * when the SDK adopts a newer LTS.
 */
const NODE_BASE_IMAGE = 'node:24-alpine';

/** The npm package providing the `adk` command inside the deployed image. */
const DEVTOOLS_NPM_PACKAGE = '@google/adk-devtools';

/** The fields this module reads out of the agent project's package.json. */
interface ProjectPackageJson {
  dependencies?: Record<string, string>;
  /** Presence marks a workspace root; the value itself is never read. */
  workspaces?: unknown;
}

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
  /** Version range the devtools package is installed at. */
  adkVersion: string;
  /** Whether a package-lock.json was staged next to the package.json. */
  hasLockfile: boolean;
}

// hasLockfile is omitted: the deploy commands stage the lock file themselves
// and pass the result on to createDockerFile, so a caller cannot supply it.
export interface BaseDeployOptions extends Omit<
  CreateDockerFileContentOptions,
  'hasLockfile'
> {
  agentPath: string;
  /**
   * Directory the generated deployment sources are staged in. When omitted, the
   * deploy command creates a private temporary directory for the run and
   * removes it when the deployment finishes.
   */
  tempFolder?: string;
  agentFileLoadOptions?: AgentFileOptions;
}

// Dockerfile instructions and the generated CMD's shell form have no
// generic escaping mechanism for interpolated values: a newline breaks out
// of the current instruction to start a new one, and shell metacharacters in
// the CMD line are interpreted by /bin/sh at container start. Restricting
// these values to a plain identifier closes both at once, since none of them
// (an agent name, a GCP project ID, or a GCP region) legitimately need
// anything outside this set.
const SAFE_DOCKERFILE_TOKEN_RE = /^[A-Za-z0-9_.-]{1,128}$/;

function assertSafeDockerfileToken(value: string, label: string): void {
  if (!SAFE_DOCKERFILE_TOKEN_RE.test(value)) {
    throw new Error(
      `Invalid ${label} ${JSON.stringify(value)}: must match ${SAFE_DOCKERFILE_TOKEN_RE} to be safely embedded in the generated Dockerfile.`,
    );
  }
}

// logLevel, allowOrigins, sessionServiceUri and artifactServiceUri are
// free-form (a service URI can carry credentials, allowOrigins is a
// comma-separated list) so they can't be restricted to the plain-identifier
// token above. They only reach the Dockerfile's CMD line, so a newline in
// any of them still breaks out of that instruction the same way appName
// does, and once inside the CMD line they're read by /bin/sh at container
// start, so shell metacharacters must be neutralized too.
//
// The rejected value is never echoed: these URIs routinely carry a password
// in their userinfo and this message is logged by the deploy commands. The
// index of the offending character is reported instead, which keeps a stray
// trailing newline diagnosable.
function assertNoDockerfileNewline(value: string, label: string): void {
  const index = value.search(/[\r\n]/);
  if (index !== -1) {
    throw new Error(
      `Invalid ${label}: must not contain newline characters to be safely embedded in the generated Dockerfile (first one at index ${index}).`,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createDockerFileContent(
  options: CreateDockerFileContentOptions,
): string {
  assertSafeDockerfileToken(options.project, 'project');
  if (options.region) {
    assertSafeDockerfileToken(options.region, 'region');
  }
  if (options.appName) {
    assertSafeDockerfileToken(options.appName, 'appName');
  }

  const adkCommand = options.withUi ? 'web' : 'api_server';
  const adkServerOptions = [`--port=${options.port}`, '--host=0.0.0.0'];

  if (options.logLevel) {
    assertNoDockerfileNewline(options.logLevel, 'logLevel');
    adkServerOptions.push(`--log_level=${shellQuote(options.logLevel)}`);
  }

  if (options.allowOrigins) {
    assertNoDockerfileNewline(options.allowOrigins, 'allowOrigins');
    adkServerOptions.push(
      `--allow_origins=${shellQuote(options.allowOrigins)}`,
    );
  }

  if (options.artifactServiceUri) {
    assertNoDockerfileNewline(options.artifactServiceUri, 'artifactServiceUri');
    adkServerOptions.push(
      `--artifact_service_uri=${shellQuote(options.artifactServiceUri)}`,
    );
  }

  if (options.sessionServiceUri) {
    assertNoDockerfileNewline(options.sessionServiceUri, 'sessionServiceUri');
    adkServerOptions.push(
      `--session_service_uri=${shellQuote(options.sessionServiceUri)}`,
    );
  }

  if (options.otelToCloud) {
    adkServerOptions.push('--otel_to_cloud');
  }

  if (options.a2a) {
    adkServerOptions.push('--a2a');
  }

  assertNoDockerfileNewline(options.adkVersion, 'adkVersion');
  const devtoolsSpec = shellQuote(
    `${DEVTOOLS_NPM_PACKAGE}@${options.adkVersion}`,
  );

  const lockfileCopy = options.hasLockfile
    ? '\nCOPY --chown=myuser:myuser "package-lock.json" "/app/package-lock.json"'
    : '';
  const dependencyInstall = options.hasLockfile
    ? 'RUN npm ci --omit=dev'
    : `# The agent project has no usable package-lock.json, so npm resolves every
# semver range against the registry at build time.
RUN npm install --omit=dev`;

  return `
FROM ${NODE_BASE_IMAGE}
WORKDIR /app

# Create a non-root user. WORKDIR made /app root-owned, and the installs below
# create /app/node_modules as myuser.
RUN adduser --disabled-password --gecos "" myuser && chown myuser:myuser /app

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
COPY --chown=myuser:myuser "package.json" "/app/package.json"${lockfileCopy}
# Copy application files

# Install Agent Deps - Start
${dependencyInstall}
# Installed last: the dependency install above clears node_modules.
RUN npm install ${devtoolsSpec}
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

/**
 * Stages the agent's dependency declaration into the deployment folder.
 *
 * The staged package.json carries only `dependencies`. The project's own
 * lifecycle scripts are dropped on purpose: `npm ci` runs the root package's
 * `prepare` script, and a `prepare` that needs the developer's checkout fails
 * the image build.
 *
 * @returns whether the project's package-lock.json was staged with it.
 */
export async function stageDependencyFiles(
  sourceFolder: string,
  targetFolder: string,
): Promise<boolean> {
  const packageJsonPath = await tryToFindFileRecursively(
    sourceFolder,
    'package.json',
    3,
  );
  const packageJson = await loadFileData<ProjectPackageJson>(packageJsonPath);
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

  await saveToFile(targetPackageJsonPath, {
    dependencies: packageJson.dependencies,
  });

  const unpinnedConsequence =
    'Dependencies will be resolved from the registry when the image is built, so the deployed tree is not reproducible.';
  const lockfilePath = path.join(
    path.dirname(packageJsonPath),
    'package-lock.json',
  );

  if (!(await isFileExists(lockfilePath))) {
    console.warn(
      `No package-lock.json beside ${packageJsonPath}.`,
      unpinnedConsequence,
    );
    return false;
  }

  // A workspace root's lock describes member packages by directory link. Those
  // directories never reach the image, and `npm ci` then reports success while
  // installing nothing.
  if (packageJson.workspaces) {
    console.warn(
      `${packageJsonPath} is a workspace root, and its package-lock.json describes packages that will not exist in the image.`,
      unpinnedConsequence,
    );
    return false;
  }

  await fs.cp(lockfilePath, path.join(targetFolder, 'package-lock.json'));
  console.info(
    'Pinning dependencies from',
    lockfilePath,
    '- the image build fails if this lock file is out of sync with package.json. Run `npm install` to refresh it.',
  );
  return true;
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
