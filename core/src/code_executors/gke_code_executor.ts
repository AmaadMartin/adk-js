/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {logger} from '../utils/logger.js';

import {BaseCodeExecutor, ExecuteCodeParams} from './base_code_executor.js';
import {CodeExecutionResult} from './code_execution_utils.js';

/** Default Kubernetes namespace, mirroring the adk-python GkeCodeExecutor. */
const DEFAULT_NAMESPACE = 'default';
/** Default Agent Sandbox template, mirroring the adk-python GkeCodeExecutor. */
const DEFAULT_SANDBOX_TEMPLATE = 'python-sandbox-template';
/** File the generated code is written to inside the sandbox. */
const SCRIPT_FILENAME = 'script.py';
/** Command run inside the sandbox to execute the script. */
const RUN_COMMAND = 'python3 script.py';

/**
 * The execution backend used by {@link GkeCodeExecutor}.
 *
 * - `'job'`: run code in a per-execution Kubernetes Job (default).
 * - `'sandbox'`: run code through the GKE Agent Sandbox infrastructure.
 */
export type GkeExecutorType = 'job' | 'sandbox';

/**
 * Result of a single command run inside an Agent Sandbox. Mirrors the shape of
 * `k8s_agent_sandbox` `SandboxClient.run(...)` in adk-python.
 */
export interface SandboxRunResult {
  /** The standard output of the command. */
  stdout: string;
  /** The standard error of the command. May be empty/undefined on success. */
  stderr?: string;
}

/** Options used to open a connection to an Agent Sandbox. */
export interface SandboxClientOptions {
  /** The Kubernetes namespace the sandbox is created in. */
  namespace: string;
  /** The sandbox template name, e.g. `'python-sandbox-template'`. */
  templateName?: string;
  /** The name of the sandbox router/gateway to connect through. */
  gatewayName?: string;
}

/**
 * Minimal client contract for the GKE Agent Sandbox: write a file, run a
 * command, then release the sandbox.
 *
 * This is the *agreed interface* — no concrete JS implementation ships in ADK
 * yet, so callers must inject one via {@link GkeCodeExecutorOptions.sandboxClientFactory}.
 */
export interface SandboxClient {
  /** Writes `content` to `path` inside the sandbox. */
  write(path: string, content: string): Promise<void>;
  /** Runs `command` inside the sandbox and returns its output. */
  run(command: string): Promise<SandboxRunResult>;
  /**
   * Releases the remote sandbox. Called in a `finally` block; implementations
   * should not throw fatal errors from here.
   */
  close(): Promise<void>;
}

/**
 * Factory that opens (and connects to) a sandbox. Injected for testability and
 * as the seam a future concrete client plugs into.
 *
 * Creation is where infrastructure/gateway/timeout failures surface, mirroring
 * Python's `with SandboxClient(...)` raising on `__enter__`.
 */
export type SandboxClientFactory = (
  options: SandboxClientOptions,
) => Promise<SandboxClient> | SandboxClient;

/**
 * Thrown for gateway/init/infrastructure failures. Maps to the `RuntimeError`
 * path in the adk-python GkeCodeExecutor.
 */
export class SandboxInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxInfrastructureError';
  }
}

/**
 * Thrown for sandbox execution timeouts. Maps to the `TimeoutError` path in the
 * adk-python GkeCodeExecutor.
 */
export class SandboxTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxTimeoutError';
  }
}

/** Options for {@link GkeCodeExecutor}. */
export interface GkeCodeExecutorOptions {
  /** The Kubernetes namespace to run in. Defaults to `'default'`. */
  namespace?: string;
  /** The execution backend to use. Defaults to `'job'`. */
  executorType?: GkeExecutorType;
  /** The Agent Sandbox template. Defaults to `'python-sandbox-template'`. */
  sandboxTemplate?: string;
  /** The Agent Sandbox router/gateway name. */
  sandboxGatewayName?: string;
  /**
   * Opens a connection to an Agent Sandbox. Required when
   * `executorType === 'sandbox'`, because no concrete JS Agent Sandbox client
   * is bundled yet.
   */
  sandboxClientFactory?: SandboxClientFactory;
}

/**
 * Returns whether `error` should be treated as a sandbox execution timeout.
 *
 * Covers both the explicit {@link SandboxTimeoutError} and standard Node
 * timeouts (e.g. `AbortSignal.timeout`, whose error has `name === 'TimeoutError'`).
 */
function isTimeoutError(error: unknown): error is Error {
  return (
    error instanceof SandboxTimeoutError ||
    (error instanceof Error && error.name === 'TimeoutError')
  );
}

/**
 * Executes code on GKE, either via a per-execution Kubernetes Job (`'job'`, the
 * default) or via the GKE Agent Sandbox infrastructure (`'sandbox'`).
 *
 * Sandbox mode requires additional infrastructure in the cluster (agent-sandbox
 * controller, sandbox templates, and a router/gateway) and executes code
 * through an injected {@link SandboxClient}.
 */
export class GkeCodeExecutor extends BaseCodeExecutor {
  readonly namespace: string;
  readonly executorType: GkeExecutorType;
  readonly sandboxTemplate: string;
  readonly sandboxGatewayName?: string;
  private readonly sandboxClientFactory?: SandboxClientFactory;

  constructor(options: GkeCodeExecutorOptions = {}) {
    super();
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.executorType = options.executorType ?? 'job';
    this.sandboxTemplate = options.sandboxTemplate ?? DEFAULT_SANDBOX_TEMPLATE;
    this.sandboxGatewayName = options.sandboxGatewayName;
    this.sandboxClientFactory = options.sandboxClientFactory;

    if (this.executorType === 'sandbox' && !this.sandboxClientFactory) {
      throw new Error(
        'Agent Sandbox client not available. To use executorType="sandbox", ' +
          'provide a sandboxClientFactory (a concrete JS Agent Sandbox client ' +
          'is not yet bundled).',
      );
    }
  }

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const code = params.codeExecutionInput.code;
    if (this.executorType === 'sandbox') {
      return this.executeInSandbox(code);
    }
    return this.executeAsJob(code, params.invocationContext);
  }

  /** Executes `code` through the injected Agent Sandbox client. */
  private async executeInSandbox(code: string): Promise<CodeExecutionResult> {
    let sandbox: SandboxClient | undefined;
    try {
      sandbox = await this.sandboxClientFactory!({
        namespace: this.namespace,
        templateName: this.sandboxTemplate,
        gatewayName: this.sandboxGatewayName,
      });
      await sandbox.write(SCRIPT_FILENAME, code);
      const result = await sandbox.run(RUN_COMMAND);
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        outputFiles: [],
      };
    } catch (e) {
      if (isTimeoutError(e)) {
        logger.error('Sandbox timed out', e);
        // Returning a result instead of throwing lets the agent process the
        // error gracefully (parity with adk-python).
        return {
          stdout: '',
          stderr: `Sandbox timed out: ${e.message}`,
          outputFiles: [],
        };
      }
      if (e instanceof SandboxInfrastructureError) {
        logger.error('SandboxClient failed to initialize or find gateway', e);
        throw new SandboxInfrastructureError(
          `Sandbox infrastructure error: ${e.message}`,
        );
      }
      logger.error('Sandbox execution failed', e);
      throw e;
    } finally {
      if (sandbox) {
        try {
          await sandbox.close();
        } catch (closeErr) {
          logger.error('Failed to close sandbox', closeErr);
        }
      }
    }
  }

  /**
   * Executes `code` as a Kubernetes Job.
   *
   * simplicity: placeholder seam. The Job-mode backend (ConfigMap + V1Job +
   * watch, requiring `@kubernetes/client-node`) is delivered by the separate
   * GkeCodeExecutor Job-mode port, which replaces this method. It is not part
   * of the sandbox-mode change and throws until that port lands.
   */
  private async executeAsJob(
    _code: string,
    _invocationContext: InvocationContext,
  ): Promise<CodeExecutionResult> {
    throw new Error(
      'Job mode is provided by the GkeCodeExecutor Job-mode port and is not ' +
        'available in this build.',
    );
  }
}
