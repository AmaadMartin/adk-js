/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Default Agent Sandbox template, mirroring the adk-python GkeCodeExecutor. */
export const DEFAULT_SANDBOX_TEMPLATE = 'python-sandbox-template';

/**
 * Result of a single command run inside an Agent Sandbox. Mirrors the shape of
 * `k8s_agent_sandbox` `SandboxClient.run(...)` in adk-python.
 */
export interface SandboxRunResult {
  /** The standard output of the command. */
  stdout: string;
  /** The standard error of the command. May be empty or absent on success. */
  stderr?: string;
  /**
   * The status the command exited with, absent when the sandbox does not
   * report one.
   */
  exitCode?: number;
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
 * ADK ships a concrete implementation (`AgentSandboxClient`); callers may still
 * inject their own through `GkeCodeExecutorOptions.sandboxClientFactory`.
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
 * Factory that opens (and connects to) a sandbox.
 *
 * Creation is where infrastructure, gateway and timeout failures surface,
 * mirroring Python's `with SandboxClient(...)` raising on `__enter__`.
 */
export type SandboxClientFactory = (
  options: SandboxClientOptions,
) => Promise<SandboxClient> | SandboxClient;

/**
 * Thrown for gateway, initialization and other infrastructure failures. Maps to
 * the `RuntimeError` path in the adk-python GkeCodeExecutor.
 */
export class SandboxInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxInfrastructureError';
  }
}

/**
 * Thrown when a sandbox operation exceeds its deadline. Maps to the
 * `TimeoutError` path in the adk-python GkeCodeExecutor.
 */
export class SandboxTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxTimeoutError';
  }
}

/**
 * Returns whether `error` is an `AbortSignal.timeout` expiry, which Node
 * reports as an error named `'TimeoutError'`.
 */
export function isAbortTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}
