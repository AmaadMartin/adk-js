/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  type ExecuteCodeParams,
  GkeCodeExecutor,
  InvocationContext,
  SandboxInfrastructureError,
  SandboxTimeoutError,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/** A mock {@link SandboxClient} whose methods are vitest spies. */
function createMockSandbox() {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue({stdout: '', stderr: ''}),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** Builds executeCode params. The sandbox path ignores the invocation context. */
function makeParams(code: string): ExecuteCodeParams {
  return {
    invocationContext: {} as unknown as InvocationContext,
    codeExecutionInput: {
      code,
      language: CodeExecutionLanguage.PYTHON,
      inputFiles: [],
    },
  };
}

describe('GkeCodeExecutor', () => {
  let sandbox: ReturnType<typeof createMockSandbox>;
  let factory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sandbox = createMockSandbox();
    factory = vi.fn(() => sandbox);
  });

  describe('constructor', () => {
    it('applies defaults', () => {
      const executor = new GkeCodeExecutor({sandboxClientFactory: factory});
      expect(executor.namespace).toBe('default');
      expect(executor.sandboxTemplate).toBe('python-sandbox-template');
      expect(executor.sandboxGatewayName).toBeUndefined();
    });
  });

  describe('executeCode', () => {
    function sandboxExecutor(): GkeCodeExecutor {
      return new GkeCodeExecutor({
        namespace: 'agents',
        sandboxTemplate: 'custom-template',
        sandboxGatewayName: 'my-gateway',
        sandboxClientFactory: factory,
      });
    }

    it('opens one sandbox with the overridden options', async () => {
      await sandboxExecutor().executeCode(makeParams('print("hi")'));

      expect(factory).toHaveBeenCalledTimes(1);
      expect(factory).toHaveBeenCalledWith({
        namespace: 'agents',
        templateName: 'custom-template',
        gatewayName: 'my-gateway',
      });
    });

    it('propagates stderr from a successful run', async () => {
      const code = "import sys; print('oops', file=sys.stderr)";
      sandbox.run.mockResolvedValue({stdout: '', stderr: 'oops\n'});

      const result = await sandboxExecutor().executeCode(makeParams(code));

      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('oops\n');
      expect(result.outputFiles).toEqual([]);
      expect(sandbox.write).toHaveBeenCalledWith('script.py', code);
      expect(sandbox.run).toHaveBeenCalledWith('python3 script.py');
    });

    it('defaults stderr to an empty string when the run omits it', async () => {
      sandbox.run.mockResolvedValue({stdout: 'ok', stderr: undefined});

      const result = await sandboxExecutor().executeCode(makeParams('x'));

      expect(result.stdout).toBe('ok');
      expect(result.stderr).toBe('');
    });

    it('rethrows generic sandbox errors unchanged', async () => {
      factory.mockRejectedValue(new Error('Connection failed'));

      const promise = sandboxExecutor().executeCode(makeParams('x'));

      await expect(promise).rejects.toThrow('Connection failed');
      await expect(promise).rejects.not.toBeInstanceOf(
        SandboxInfrastructureError,
      );
    });

    it('rethrows non-Error thrown values unchanged', async () => {
      factory.mockRejectedValue('weird failure');

      await expect(sandboxExecutor().executeCode(makeParams('x'))).rejects.toBe(
        'weird failure',
      );
    });

    it('wraps infrastructure errors, preserving the original as cause', async () => {
      const original = new SandboxInfrastructureError('Gateway not found');
      factory.mockRejectedValue(original);

      const promise = sandboxExecutor().executeCode(makeParams('x'));

      await expect(promise).rejects.toThrow(
        'Sandbox infrastructure error: Gateway not found',
      );
      await expect(promise).rejects.toBeInstanceOf(SandboxInfrastructureError);
      await expect(promise).rejects.toHaveProperty('cause', original);
    });

    it('returns a result on a SandboxTimeoutError', async () => {
      factory.mockRejectedValue(new SandboxTimeoutError('Execution timed out'));

      const result = await sandboxExecutor().executeCode(makeParams('x'));

      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Sandbox timed out: Execution timed out');
      expect(result.outputFiles).toEqual([]);
    });

    it('returns a result on a native TimeoutError', async () => {
      const error = new Error('Execution timed out');
      error.name = 'TimeoutError';
      factory.mockRejectedValue(error);

      const result = await sandboxExecutor().executeCode(makeParams('x'));

      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Sandbox timed out: Execution timed out');
    });

    it('closes the sandbox when the run throws', async () => {
      sandbox.run.mockRejectedValue(new Error('run failed'));

      await expect(
        sandboxExecutor().executeCode(makeParams('x')),
      ).rejects.toThrow('run failed');
      expect(sandbox.close).toHaveBeenCalledTimes(1);
    });

    it('closes the sandbox after a successful run, swallowing close errors', async () => {
      sandbox.run.mockResolvedValue({stdout: 'still ok', stderr: ''});
      sandbox.close.mockRejectedValue(new Error('close failed'));

      const result = await sandboxExecutor().executeCode(makeParams('x'));

      expect(result.stdout).toBe('still ok');
      expect(sandbox.close).toHaveBeenCalledTimes(1);
    });
  });
});
