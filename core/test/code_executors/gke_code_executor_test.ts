/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  type CodeExecutionResult,
  type ExecuteCodeParams,
  GkeCodeExecutor,
  InvocationContext,
  type SandboxClientOptions,
  SandboxInfrastructureError,
  type SandboxRunResult,
  SandboxTimeoutError,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/** A mock {@link SandboxClient} whose methods are vitest spies. */
interface MockSandbox {
  write: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function createMockSandbox(
  runResult: SandboxRunResult = {stdout: '', stderr: ''},
): MockSandbox {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(runResult),
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

/** Exposes the private `executeAsJob` method for spying. */
interface WithExecuteAsJob {
  executeAsJob: (
    code: string,
    invocationContext: InvocationContext,
  ) => Promise<CodeExecutionResult>;
}

describe('GkeCodeExecutor', () => {
  let sandbox: MockSandbox;
  let factory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sandbox = createMockSandbox();
    factory = vi.fn((_options: SandboxClientOptions) => sandbox);
  });

  describe('constructor', () => {
    it('applies defaults', () => {
      const executor = new GkeCodeExecutor();
      expect(executor.executorType).toBe('job');
      expect(executor.namespace).toBe('default');
      expect(executor.sandboxTemplate).toBe('python-sandbox-template');
      expect(executor.sandboxGatewayName).toBeUndefined();
    });

    it('constructs in sandbox mode with overrides', () => {
      const executor = new GkeCodeExecutor({
        executorType: 'sandbox',
        namespace: 'test-ns',
        sandboxClientFactory: factory,
      });
      expect(executor.executorType).toBe('sandbox');
      expect(executor.namespace).toBe('test-ns');
      expect(executor.sandboxTemplate).toBe('python-sandbox-template');
    });

    it('honors a custom sandbox template and gateway name', () => {
      const executor = new GkeCodeExecutor({
        executorType: 'sandbox',
        sandboxTemplate: 'custom-template',
        sandboxGatewayName: 'my-gateway',
        sandboxClientFactory: factory,
      });
      expect(executor.sandboxTemplate).toBe('custom-template');
      expect(executor.sandboxGatewayName).toBe('my-gateway');
    });

    it('throws when sandbox mode selected without a client factory', () => {
      expect(() => new GkeCodeExecutor({executorType: 'sandbox'})).toThrow(
        'Agent Sandbox client not available',
      );
    });
  });

  describe('executeCode routing', () => {
    it('forks to sandbox', async () => {
      sandbox.run.mockResolvedValue({
        stdout: 'sandbox stdout',
        stderr: undefined,
      });
      const executor = new GkeCodeExecutor({
        executorType: 'sandbox',
        sandboxClientFactory: factory,
      });
      const jobSpy = vi.spyOn(
        executor as unknown as WithExecuteAsJob,
        'executeAsJob',
      );

      const result = await executor.executeCode(makeParams('print("sandbox")'));

      expect(result.stdout).toBe('sandbox stdout');
      expect(factory).toHaveBeenCalledTimes(1);
      expect(sandbox.run).toHaveBeenCalledTimes(1);
      expect(jobSpy).not.toHaveBeenCalled();
    });

    it('forks to job', async () => {
      const executor = new GkeCodeExecutor({
        executorType: 'job',
        sandboxClientFactory: factory,
      });
      const jobSpy = vi
        .spyOn(executor as unknown as WithExecuteAsJob, 'executeAsJob')
        .mockResolvedValue({stdout: 'job stdout', stderr: '', outputFiles: []});

      const result = await executor.executeCode(makeParams('print("job")'));

      expect(result.stdout).toBe('job stdout');
      expect(jobSpy).toHaveBeenCalledTimes(1);
      expect(factory).not.toHaveBeenCalled();
    });

    it('throws from the placeholder job backend until the port lands', async () => {
      const executor = new GkeCodeExecutor();
      await expect(
        executor.executeCode(makeParams('print("job")')),
      ).rejects.toThrow(
        'Job mode is provided by the GkeCodeExecutor Job-mode port',
      );
    });
  });

  describe('executeInSandbox', () => {
    function sandboxExecutor(): GkeCodeExecutor {
      return new GkeCodeExecutor({
        executorType: 'sandbox',
        namespace: 'agents',
        sandboxTemplate: 'python-sandbox-template',
        sandboxGatewayName: 'my-gateway',
        sandboxClientFactory: factory,
      });
    }

    it('opens the sandbox with the configured options', async () => {
      await sandboxExecutor().executeCode(makeParams('print("hi")'));

      expect(factory).toHaveBeenCalledWith({
        namespace: 'agents',
        templateName: 'python-sandbox-template',
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

    it('wraps infrastructure errors', async () => {
      factory.mockRejectedValue(
        new SandboxInfrastructureError('Gateway not found'),
      );

      const promise = sandboxExecutor().executeCode(makeParams('x'));

      await expect(promise).rejects.toThrow(
        'Sandbox infrastructure error: Gateway not found',
      );
      await expect(promise).rejects.toBeInstanceOf(SandboxInfrastructureError);
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

    it('closes the sandbox after a successful run', async () => {
      await sandboxExecutor().executeCode(makeParams('x'));
      expect(sandbox.close).toHaveBeenCalledTimes(1);
    });

    it('closes the sandbox when the run throws', async () => {
      sandbox.run.mockRejectedValue(new Error('run failed'));

      await expect(
        sandboxExecutor().executeCode(makeParams('x')),
      ).rejects.toThrow('run failed');
      expect(sandbox.close).toHaveBeenCalledTimes(1);
    });

    it('swallows errors thrown while closing the sandbox', async () => {
      sandbox.run.mockResolvedValue({stdout: 'still ok', stderr: ''});
      sandbox.close.mockRejectedValue(new Error('close failed'));

      const result = await sandboxExecutor().executeCode(makeParams('x'));

      expect(result.stdout).toBe('still ok');
      expect(sandbox.close).toHaveBeenCalledTimes(1);
    });
  });
});
