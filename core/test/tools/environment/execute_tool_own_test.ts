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
  REQUIRE_CONFIRMATION_MESSAGE,
  ToolConfirmation,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  FailingEnvironment,
  RecordingEnvironment,
  makeConfirmedContext,
  makeContext,
  makeRejectedContext,
} from './environment_test_utils.js';

const MISSING_COMMAND_ERROR = {
  status: 'error',
  error: '`command` is required.',
};

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
    const environment = new FailingEnvironment(new Error('spawn failed'));
    expect(await run(environment, {command: 'ls'})).toEqual({
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

describe('ExecuteTool argument validation', () => {
  it.each([
    ['missing', {}],
    ['empty', {command: ''}],
    ['a number', {command: 42}],
    ['an object', {command: {cmd: 'ls'}}],
    ['null', {command: null}],
  ])('rejects a command that is %s', async (_label, args) => {
    const environment = new RecordingEnvironment();
    const tool = new ExecuteTool(environment);

    const result = await tool.runAsync({
      args,
      toolContext: makeConfirmedContext(),
    });

    expect(result).toEqual(MISSING_COMMAND_ERROR);
    expect(environment.commands).toEqual([]);
  });
});

describe('ExecuteTool declaration', () => {
  it('declares a single required command string', () => {
    const tool = new ExecuteTool(new RecordingEnvironment());

    expect(tool._getDeclaration()).toEqual({
      name: 'Execute',
      description: tool.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          command: {
            type: Type.STRING,
            description:
              'The shell command to execute. Chain dependent commands with &&.',
          },
        },
        required: ['command'],
      },
    });
  });

  it('is named Execute and describes when not to use it', () => {
    const tool = new ExecuteTool(new RecordingEnvironment());

    expect(tool.name).toBe('Execute');
    expect(tool.description).toContain(
      'Run a shell command in the environment',
    );
    expect(tool.description).toContain('Do NOT use for file reading');
  });
});

describe('ExecuteTool execution', () => {
  it('passes the command and the default timeout to the environment', async () => {
    const environment = new RecordingEnvironment();
    const tool = new ExecuteTool(environment);

    await tool.runAsync({
      args: {command: 'npm test'},
      toolContext: makeConfirmedContext(),
    });

    expect(environment.commands).toEqual(['npm test']);
    expect(environment.timeouts).toEqual([30]);
  });

  it('returns stdout alone when the command writes nothing to stderr', async () => {
    const environment = new RecordingEnvironment({stdout: 'built\n'});
    const tool = new ExecuteTool(environment);

    const result = await tool.runAsync({
      args: {command: 'make'},
      toolContext: makeConfirmedContext(),
    });

    expect(result).toEqual({status: 'ok', stdout: 'built\n'});
  });

  it('returns stderr when the command writes to it', async () => {
    const environment = new RecordingEnvironment({
      stdout: 'out',
      stderr: 'warning',
    });
    const tool = new ExecuteTool(environment);

    const result = await tool.runAsync({
      args: {command: 'make'},
      toolContext: makeConfirmedContext(),
    });

    expect(result).toEqual({status: 'ok', stdout: 'out', stderr: 'warning'});
  });

  it('omits both output keys when the command is silent', async () => {
    const environment = new RecordingEnvironment();
    const tool = new ExecuteTool(environment);

    const result = await tool.runAsync({
      args: {command: 'true'},
      toolContext: makeConfirmedContext(),
    });

    expect(result).toEqual({status: 'ok'});
  });

  it('reports a non-zero exit code as an error and keeps the output', async () => {
    const environment = new RecordingEnvironment({
      exitCode: 2,
      stdout: 'partial',
    });
    const tool = new ExecuteTool(environment);

    const result = await tool.runAsync({
      args: {command: 'false'},
      toolContext: makeConfirmedContext(),
    });

    expect(result).toEqual({
      status: 'error',
      stdout: 'partial',
      exit_code: 2,
    });
  });

  it('reports a timeout with the default timeout in the message', async () => {
    const environment = new RecordingEnvironment({timedOut: true});
    const tool = new ExecuteTool(environment);

    const result = await tool.runAsync({
      args: {command: 'sleep 600'},
      toolContext: makeConfirmedContext(),
    });

    expect(result).toEqual({
      status: 'error',
      error: 'Command timed out after 30s.',
    });
  });

  it('reports both the exit code and the timeout when a killed command exits non-zero', async () => {
    const environment = new RecordingEnvironment({
      exitCode: 137,
      timedOut: true,
    });
    const tool = new ExecuteTool(environment);

    const result = await tool.runAsync({
      args: {command: 'sleep 600'},
      toolContext: makeConfirmedContext(),
    });

    expect(result).toEqual({
      status: 'error',
      exit_code: 137,
      error: 'Command timed out after 30s.',
    });
  });

  it('truncates stdout and stderr independently', async () => {
    const environment = new RecordingEnvironment({
      stdout: 'a'.repeat(12),
      stderr: 'b'.repeat(12),
    });
    const tool = new ExecuteTool(environment, {maxOutputChars: 10});

    const result = await tool.runAsync({
      args: {command: 'noisy'},
      toolContext: makeConfirmedContext(),
    });

    expect(result).toEqual({
      status: 'ok',
      stdout: `${'a'.repeat(10)}\n... (truncated, 12 total chars)`,
      stderr: `${'b'.repeat(10)}\n... (truncated, 12 total chars)`,
    });
  });

  it('falls back to the default cap when maxOutputChars is undefined', async () => {
    const environment = new RecordingEnvironment({stdout: 'a'.repeat(30_001)});
    const tool = new ExecuteTool(environment, {maxOutputChars: undefined});

    const result = await tool.runAsync({
      args: {command: 'noisy'},
      toolContext: makeConfirmedContext(),
    });

    expect(result).toEqual({
      status: 'ok',
      stdout: `${'a'.repeat(30_000)}\n... (truncated, 30001 total chars)`,
    });
  });

  it('honours a maxOutputChars of zero rather than treating it as unset', async () => {
    const environment = new RecordingEnvironment({stdout: 'output'});
    const tool = new ExecuteTool(environment, {maxOutputChars: 0});

    const result = await tool.runAsync({
      args: {command: 'echo output'},
      toolContext: makeConfirmedContext(),
    });

    expect(result).toEqual({
      status: 'ok',
      stdout: '\n... (truncated, 6 total chars)',
    });
  });

  it('returns the formatted error when the environment throws', async () => {
    const environment = new FailingEnvironment(
      new Error('Environment is not initialized. Call initialize() first.'),
    );
    const tool = new ExecuteTool(environment);

    const result = await tool.runAsync({
      args: {command: 'ls'},
      toolContext: makeConfirmedContext(),
    });

    expect(result).toEqual({
      status: 'error',
      error: 'Environment is not initialized. Call initialize() first.',
    });
  });
});

describe('ExecuteTool confirmation gate', () => {
  it('pauses and records a confirmation request on the first call', async () => {
    const environment = new RecordingEnvironment();
    const tool = new ExecuteTool(environment);
    const context = makeContext();

    const result = await tool.runAsync({
      args: {command: 'rm -rf /'},
      toolContext: context,
    });

    expect(result).toEqual({partial: REQUIRE_CONFIRMATION_MESSAGE});
    expect(environment.commands).toEqual([]);

    const request = context.actions.requestedToolConfirmations['fc-1'];
    expect(request.confirmed).toBe(false);
    expect(request.hint).toContain('rm -rf /');
    expect(request.payload).toEqual({command: 'rm -rf /'});
  });

  it('refuses to run when the client rejected the call', async () => {
    const environment = new RecordingEnvironment();
    const tool = new ExecuteTool(environment);

    const result = await tool.runAsync({
      args: {command: 'rm -rf /'},
      toolContext: makeRejectedContext(),
    });

    expect(result).toEqual({
      status: 'error',
      error: 'Command execution was not confirmed and was rejected.',
      errorCode: ExecuteToolErrorCode.CONFIRMATION_REJECTED,
    });
    expect(environment.commands).toEqual([]);
  });

  it('runs the command once the client approved the call', async () => {
    const environment = new RecordingEnvironment({stdout: 'ok'});
    const tool = new ExecuteTool(environment);

    const result = await tool.runAsync({
      args: {command: 'ls'},
      toolContext: makeConfirmedContext(),
    });

    expect(result).toEqual({status: 'ok', stdout: 'ok'});
    expect(environment.commands).toEqual(['ls']);
  });

  it('gates before running, so a rejected call never reaches the environment', async () => {
    const environment = new RecordingEnvironment();
    const tool = new ExecuteTool(environment);

    await tool.runAsync({
      args: {command: 'ls'},
      toolContext: makeContext(),
    });
    await tool.runAsync({
      args: {command: 'ls'},
      toolContext: makeRejectedContext(),
    });

    expect(environment.commands).toEqual([]);
  });
});

describe('ExecuteTool.detectErrorInResponse', () => {
  it.each([
    ['undefined', undefined],
    ['a string', 'text'],
    ['null', null],
    ['a number', 7],
  ])('returns undefined for %s', (_label, response) => {
    const tool = new ExecuteTool(new RecordingEnvironment());

    expect(tool.detectErrorInResponse(response)).toBeUndefined();
  });

  it('returns undefined for an object with a non-error status', () => {
    const tool = new ExecuteTool(new RecordingEnvironment());

    expect(tool.detectErrorInResponse({status: 'pending'})).toBeUndefined();
  });

  it('reports the response of a failed run as a tool error', async () => {
    const tool = new ExecuteTool(new RecordingEnvironment({exitCode: 1}));

    const result = await tool.runAsync({
      args: {command: 'false'},
      toolContext: makeConfirmedContext(),
    });

    expect(tool.detectErrorInResponse(result)).toBe('TOOL_ERROR');
  });
});
