/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type Docker from 'dockerode';
import * as path from 'node:path';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {
  CodeExecutionLanguage,
  CodeExecutionResult,
} from './code_execution_utils.js';
import {
  DockerContainer,
  type DockerContainerOptions,
} from './docker_container.js';
import {
  PYTHON_TIMEOUT_WRAPPER,
  TIMEOUT_EXIT_CODE,
} from './python_timeout_wrapper.js';

/** The image tag used when the caller names none. Matches adk-python. */
const DEFAULT_IMAGE_TAG = 'adk-code-executor:latest';

/** The wall-clock bound applied when the caller sets none. Matches adk-python. */
const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * The argv prefix that runs a code string under each supported language. The
 * code is appended as the final argument.
 *
 * TypeScript runs through `npx tsx`, which type-strips and executes in one
 * step, so the image needs no separate compile step and no `tsconfig`.
 */
const LANGUAGE_RUNTIME_COMMAND_MAP: Partial<
  Record<CodeExecutionLanguage, string[]>
> = {
  [CodeExecutionLanguage.PYTHON]: ['python3', '-c'],
  [CodeExecutionLanguage.JAVASCRIPT]: ['node', '-e'],
  [CodeExecutionLanguage.TYPESCRIPT]: ['npx', '--yes', 'tsx', '--eval'],
  [CodeExecutionLanguage.SHELL]: ['sh', '-c'],
};

/** Options for {@link ContainerCodeExecutor}. */
export interface ContainerCodeExecutorOptions {
  /** Base url of a user-hosted Docker daemon, e.g. `tcp://host:2375`. */
  baseUrl?: string;
  /**
   * Tag of the predefined or custom image to run on the container. Either
   * `image` or `dockerPath` must be set. Defaults to
   * `adk-code-executor:latest` when only `dockerPath` is given.
   */
  image?: string;
  /**
   * Path to a directory that holds a Dockerfile. When set, the image is built
   * from it instead of pulled from a prebuilt tag. Either `image` or
   * `dockerPath` must be set.
   */
  dockerPath?: string;
  /**
   * Start the container with networking enabled. Defaults to false so that
   * untrusted, model-generated code cannot reach the network: the cloud
   * metadata endpoint, internal services, or exfiltration destinations.
   */
  networkEnabled?: boolean;
  /**
   * Wall-clock bound in seconds on one execution, enforced inside the
   * container. It must be a positive integer. Defaults to 300.
   */
  timeoutSeconds?: number;
  /**
   * Injected Docker client, so that unit tests never reach a real daemon.
   * Defaults to a new client built from `baseUrl`.
   */
  docker?: Docker;
}

/**
 * A code executor that runs model-generated code inside a hardened Docker
 * container.
 *
 * Security note: this executor runs model-generated code, which untrusted
 * input can influence through prompt injection. The container starts with
 * networking disabled, every Linux capability dropped, and `no-new-privileges`
 * set, so the code cannot reach the network (including the cloud metadata
 * endpoint at `169.254.169.254`) and cannot escalate privileges. Set
 * `networkEnabled: true` only when you trust the executed code. For
 * kernel-level isolation prefer a managed executor such as
 * {@link AgentEngineSandboxCodeExecutor}.
 *
 * One container serves every execution of one instance, so a run that never
 * returns would pin that container for every later caller. Every execution
 * therefore runs under the bound described on `timeoutSeconds`.
 *
 * `dockerode` is an optional peer dependency. Install it with
 * `npm install dockerode` before using this executor.
 */
@experimental
export class ContainerCodeExecutor extends BaseCodeExecutor {
  private readonly dockerPath?: string;
  private readonly containerOptions: DockerContainerOptions;
  private readonly timeoutSeconds: number;
  private container?: DockerContainer;
  private initPromise?: Promise<DockerContainer>;

  constructor(options: ContainerCodeExecutorOptions = {}) {
    super();
    if (!options.image && !options.dockerPath) {
      throw new Error(
        'Either image or dockerPath must be set for ContainerCodeExecutor.',
      );
    }
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    if (!Number.isInteger(this.timeoutSeconds) || this.timeoutSeconds <= 0) {
      throw new Error('timeoutSeconds must be a positive integer.');
    }
    this.dockerPath = options.dockerPath
      ? path.resolve(options.dockerPath)
      : undefined;
    this.containerOptions = {
      image: options.image ?? DEFAULT_IMAGE_TAG,
      networkEnabled: options.networkEnabled ?? false,
      baseUrl: options.baseUrl,
      docker: options.docker,
    };
    // Mirrors the frozen fields in adk-python: this executor is never stateful
    // and never optimizes data files.
    this.stateful = false;
    this.optimizeDataFile = false;
  }

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const {code, language} = params.codeExecutionInput;
    // adk-python always shells out to python3. Here the declared language
    // picks the interpreter, so a JavaScript snippet is not fed to Python and
    // failed at parse time.
    const command = LANGUAGE_RUNTIME_COMMAND_MAP[language];
    if (!command) {
      throw new Error(
        `Unsupported language for ContainerCodeExecutor: ${language}. ` +
          `Supported: ${Object.keys(LANGUAGE_RUNTIME_COMMAND_MAP).join(', ')}.`,
      );
    }
    const container = await this.ensureContainer();
    const {stdout, stderr, exitCode} = await container.execute([
      'python3',
      '-c',
      PYTHON_TIMEOUT_WRAPPER,
      String(this.timeoutSeconds),
      ...command,
      code,
    ]);
    logger.debug(`Executed ${language} code:\n\`\`\`\n${code}\n\`\`\``);
    const notice = `Code execution timed out after ${this.timeoutSeconds} seconds.`;
    return {
      stdout,
      // The notice is appended, not assigned: what the code wrote before the
      // bound expired is the useful diagnostic, but alone it hides the kill.
      stderr:
        exitCode === TIMEOUT_EXIT_CODE
          ? [stderr, notice].filter(Boolean).join('\n')
          : stderr,
      outputFiles: [],
      exitCode,
    };
  }

  /**
   * Stops and removes the container. It does nothing when the executor never
   * started one, so it is safe to call twice. When Docker rejects, the error
   * propagates and the executor keeps the container, so that a later
   * `close()` or the process exit hook retries the cleanup.
   *
   * A start still in flight is awaited first, so the container it goes on to
   * create is stopped rather than orphaned. A start that failed leaves nothing
   * to stop, and clearing it here lets the next execution try again instead of
   * replaying the old error forever.
   */
  async close(): Promise<void> {
    if (!this.initPromise) {
      return;
    }
    await this.initPromise.catch(() => undefined);
    if (this.container) {
      await this.container.stop();
      this.container = undefined;
    }
    this.initPromise = undefined;
  }

  /**
   * Builds and starts the container at most once, however many concurrent
   * executions arrive.
   */
  private ensureContainer(): Promise<DockerContainer> {
    this.initPromise ??= this.initContainer();
    return this.initPromise;
  }

  private async initContainer(): Promise<DockerContainer> {
    const container = new DockerContainer(this.containerOptions);
    if (this.dockerPath) {
      await container.build(this.dockerPath);
    }
    await container.start();
    // Assigned before the probe so that a failing probe still leaves the
    // container reachable by `close()`.
    this.container = container;

    const {exitCode} = await container.execute(['which', 'python3']);
    if (exitCode !== 0) {
      throw new Error('python3 is not installed in the container.');
    }
    return container;
  }
}
