/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
const RUN_COMMAND = `python3 ${SCRIPT_FILENAME}`;

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
  templateName: string;
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
   * Releases the remote sandbox. Called after execution on both the success and
   * error paths; implementations should not throw fatal errors from here.
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
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
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
  /**
   * Opens a connection to an Agent Sandbox. Required, because no concrete JS
   * Agent Sandbox client is bundled yet.
   */
  sandboxClientFactory: SandboxClientFactory;
  /** The Kubernetes namespace to run in. Defaults to `'default'`. */
  namespace?: string;
  /** The Agent Sandbox template. Defaults to `'python-sandbox-template'`. */
  sandboxTemplate?: string;
  /** The Agent Sandbox router/gateway name. */
  sandboxGatewayName?: string;
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
 * Releases `sandbox` if it was opened, swallowing (and logging) any error so
 * cleanup never masks the primary result or error.
 */
async function closeSandboxQuietly(sandbox?: SandboxClient): Promise<void> {
  try {
    await sandbox?.close();
  } catch (closeErr) {
    logger.error('Failed to close sandbox', closeErr);
  }
}

/**
 * Executes code on GKE through the Agent Sandbox infrastructure.
 *
 * This requires additional infrastructure in the cluster (agent-sandbox
 * controller, sandbox templates, and a router/gateway), and runs code through
 * an injected {@link SandboxClient}.
 */
export class GkeCodeExecutor extends BaseCodeExecutor {
  readonly namespace: string;
  readonly sandboxTemplate: string;
  readonly sandboxGatewayName?: string;
  private readonly sandboxClientFactory: SandboxClientFactory;

  constructor(options: GkeCodeExecutorOptions) {
    super();
    this.sandboxClientFactory = options.sandboxClientFactory;
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.sandboxTemplate = options.sandboxTemplate ?? DEFAULT_SANDBOX_TEMPLATE;
    this.sandboxGatewayName = options.sandboxGatewayName;
  }

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    const code = params.codeExecutionInput.code;
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
    } catch (e) {
      await closeSandboxQuietly(sandbox);
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
          {cause: e},
        );
      }
      logger.error('Sandbox execution failed', e);
      throw e;
    }
  }
}
