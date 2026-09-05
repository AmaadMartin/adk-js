/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `main`,
 * `tests/unittests/tools/test_environment_toolset.py`. Test names are kept
 * verbatim so the two suites can be compared by name.
 */

import {
  BaseEnvironment,
  BaseTool,
  EnvironmentToolset,
  ExecutionResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {makeConfirmedContext} from './environment_test_utils.js';

/** Fake environment to return customized execution and read results. */
class FakeEnvironment extends BaseEnvironment {
  constructor(
    private readonly stdout: string,
    private readonly fileContent: Uint8Array,
  ) {
    super();
  }

  override get workingDir(): string {
    return '/workspace';
  }

  override async execute(): Promise<ExecutionResult> {
    return {exitCode: 0, stdout: this.stdout, stderr: '', timedOut: false};
  }

  override async readFile(): Promise<Uint8Array> {
    return this.fileContent;
  }

  override async writeFile(): Promise<void> {}
}

function findTool(tools: BaseTool[], name: string): BaseTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    expect.fail(`no tool named ${name}`);
  }
  return tool;
}

function makeEnvironment(text: string): FakeEnvironment {
  return new FakeEnvironment(text, new TextEncoder().encode(text));
}

describe('EnvironmentToolset', () => {
  it('test_default_truncation_limit', async () => {
    const longText = 'a'.repeat(40_000);
    const toolset = new EnvironmentToolset({
      environment: makeEnvironment(longText),
    });
    const tools = await toolset.getTools();
    const noticeLength = '\n... (truncated, 40000 total chars)'.length;

    const executeResult = (await findTool(tools, 'Execute').runAsync({
      args: {command: 'dummy'},
      // Divergence from adk-python: adk-js gates `Execute` behind a tool
      // confirmation, so the call is approved to reach the truncation this
      // test measures.
      toolContext: makeConfirmedContext(),
    })) as {status: string; stdout: string};
    expect(executeResult.status).toBe('ok');
    expect(executeResult.stdout.length).toBe(30_000 + noticeLength);
    expect(
      executeResult.stdout.endsWith('\n... (truncated, 40000 total chars)'),
    ).toBe(true);

    const readResult = (await findTool(tools, 'ReadFile').runAsync({
      args: {path: 'dummy.txt'},
      toolContext: makeConfirmedContext(),
    })) as {status: string; content: string};
    expect(readResult.status).toBe('ok');
    expect(readResult.content.length).toBe(30_000 + noticeLength);
  });

  it('test_custom_truncation_limit', async () => {
    const longText = 'a'.repeat(40_000);
    const toolset = new EnvironmentToolset({
      environment: makeEnvironment(longText),
      maxOutputChars: 10_000,
    });
    const tools = await toolset.getTools();
    const noticeLength = '\n... (truncated, 40000 total chars)'.length;

    const executeResult = (await findTool(tools, 'Execute').runAsync({
      args: {command: 'dummy'},
      toolContext: makeConfirmedContext(),
    })) as {status: string; stdout: string};
    expect(executeResult.status).toBe('ok');
    expect(executeResult.stdout.length).toBe(10_000 + noticeLength);

    const readResult = (await findTool(tools, 'ReadFile').runAsync({
      args: {path: 'dummy.txt'},
      toolContext: makeConfirmedContext(),
    })) as {status: string; content: string};
    expect(readResult.status).toBe('ok');
    expect(readResult.content.length).toBe(10_000 + noticeLength);
  });

  it('test_no_truncation_under_limit', async () => {
    const shortText = 'a'.repeat(100);
    const toolset = new EnvironmentToolset({
      environment: makeEnvironment(shortText),
      maxOutputChars: 10_000,
    });
    const tools = await toolset.getTools();

    const executeResult = (await findTool(tools, 'Execute').runAsync({
      args: {command: 'dummy'},
      toolContext: makeConfirmedContext(),
    })) as {status: string; stdout: string};
    expect(executeResult.status).toBe('ok');
    expect(executeResult.stdout).toBe(shortText);
  });
});
