/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseEnvironment,
  ExecuteTool,
  ExecuteToolErrorCode,
  ExecutionResult,
  ToolConfirmation,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {makeConfirmedContext, makeContext} from './environment_test_utils.js';

/** Environment double that records the arguments `Execute` passes it. */
class RecordingEnvironment extends BaseEnvironment {
  readonly timeouts: Array<number | undefined> = [];

  constructor(private readonly result: ExecutionResult) {
    super();
  }

  override get workingDir(): string {
    return '/workspace';
  }

  override async execute(
    command: string,
    timeoutSeconds?: number,
  ): Promise<ExecutionResult> {
    this.timeouts.push(timeoutSeconds);
    return this.result;
  }

  override async readFile(): Promise<Uint8Array> {
    throw new Error('not implemented');
  }

  override async writeFile(): Promise<void> {
    throw new Error('not implemented');
  }
}

/** Environment double whose `execute` always rejects. */
class FailingEnvironment extends BaseEnvironment {
  override get workingDir(): string {
    return '/workspace';
  }

  override async execute(): Promise<ExecutionResult> {
    throw new Error('spawn failed');
  }

  override async readFile(): Promise<Uint8Array> {
    throw new Error('not implemented');
  }

  override async writeFile(): Promise<void> {
    throw new Error('not implemented');
  }
}

function ok(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {exitCode: 0, stdout: '', stderr: '', timedOut: false, ...overrides};
}

async function run(
  environment: BaseEnvironment,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await new ExecuteTool(environment).runAsync({
    args,
    toolContext: makeConfirmedContext(),
  })) as Record<string, unknown>;
}

describe('ExecuteTool', () => {
  it('rejects a missing command', async () => {
    expect(await run(new RecordingEnvironment(ok()), {})).toEqual({
      status: 'error',
      error: '`command` is required.',
    });
  });

  it('rejects an empty command', async () => {
    expect(await run(new RecordingEnvironment(ok()), {command: ''})).toEqual({
      status: 'error',
      error: '`command` is required.',
    });
  });

  it('reports a rejected execute() call', async () => {
    expect(await run(new FailingEnvironment(), {command: 'ls'})).toEqual({
      status: 'error',
      error: 'spawn failed',
    });
  });

  it('passes the default timeout to the environment', async () => {
    const environment = new RecordingEnvironment(ok({stdout: 'hi'}));
    await run(environment, {command: 'echo hi'});
    expect(environment.timeouts).toEqual([30]);
  });

  it('reports a non-zero exit code as an error with exit_code', async () => {
    const environment = new RecordingEnvironment(
      ok({exitCode: 2, stderr: 'boom'}),
    );
    expect(await run(environment, {command: 'false'})).toEqual({
      status: 'error',
      stderr: 'boom',
      exit_code: 2,
    });
  });

  it('reports a timeout, keeping the exit code alongside it', async () => {
    const environment = new RecordingEnvironment(
      ok({exitCode: -9, stdout: 'partial', timedOut: true}),
    );
    expect(await run(environment, {command: 'sleep 99'})).toEqual({
      status: 'error',
      stdout: 'partial',
      exit_code: -9,
      error: 'Command timed out after 30s.',
    });
  });

  it('reports a timeout on its own when the command still exited 0', async () => {
    const environment = new RecordingEnvironment(ok({timedOut: true}));
    expect(await run(environment, {command: 'sleep 99'})).toEqual({
      status: 'error',
      error: 'Command timed out after 30s.',
    });
  });

  it('leaves a `$&` sequence in stdout untouched', async () => {
    const environment = new RecordingEnvironment(ok({stdout: 'a $& b $1 c'}));
    expect(await run(environment, {command: 'echo'})).toEqual({
      status: 'ok',
      stdout: 'a $& b $1 c',
    });
  });

  it('honours an explicit maxOutputChars of 0', async () => {
    const tool = new ExecuteTool(
      new RecordingEnvironment(ok({stdout: 'abc'})),
      {
        maxOutputChars: 0,
      },
    );
    const result = (await tool.runAsync({
      args: {command: 'echo abc'},
      toolContext: makeConfirmedContext(),
    })) as {stdout: string};
    expect(result.stdout).toBe('\n... (truncated, 3 total chars)');
  });

  it('declares the command argument as required', () => {
    const declaration = new ExecuteTool(
      new RecordingEnvironment(ok()),
    )._getDeclaration();
    expect(declaration.name).toBe('Execute');
    expect(declaration.parameters?.required).toEqual(['command']);
  });

  describe('confirmation gate', () => {
    it('requests confirmation and does not run the command', async () => {
      const environment = new RecordingEnvironment(ok({stdout: 'ran'}));
      const toolContext = makeContext({functionCallId: 'fc-1'});

      const result = await new ExecuteTool(environment).runAsync({
        args: {command: 'rm -rf /'},
        toolContext,
      });

      expect(result).toEqual({
        partial:
          'This tool call needs external confirmation before completion.',
      });
      expect(environment.timeouts).toEqual([]);
      expect(
        toolContext.eventActions.requestedToolConfirmations['fc-1'],
      ).toBeDefined();
    });

    it('refuses to run the command when confirmation is denied', async () => {
      const environment = new RecordingEnvironment(ok({stdout: 'ran'}));
      const toolContext = makeContext({
        functionCallId: 'fc-1',
        toolConfirmation: new ToolConfirmation({confirmed: false}),
      });

      const result = await new ExecuteTool(environment).runAsync({
        args: {command: 'rm -rf /'},
        toolContext,
      });

      expect(result).toEqual({
        status: 'error',
        error: 'Command execution was not confirmed and was rejected.',
        errorCode: ExecuteToolErrorCode.CONFIRMATION_REJECTED,
      });
      expect(environment.timeouts).toEqual([]);
    });
  });
});
