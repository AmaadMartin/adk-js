/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseEnvironment,
  BaseTool,
  EnvironmentToolset,
  ExecutionResult,
  LlmRequest,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {makeConfirmedContext, makeContext} from './environment_test_utils.js';

/** Environment double counting its own lifecycle calls. */
class CountingEnvironment extends BaseEnvironment {
  initializeCalls = 0;
  closeCalls = 0;

  override get workingDir(): string {
    return '/tmp/env-under-test';
  }

  override async initialize(): Promise<void> {
    this.initializeCalls++;
  }

  override async close(): Promise<void> {
    this.closeCalls++;
  }

  override async execute(): Promise<ExecutionResult> {
    return {exitCode: 0, stdout: 'x'.repeat(50), stderr: '', timedOut: false};
  }

  override async readFile(): Promise<Uint8Array> {
    return new TextEncoder().encode('y'.repeat(50));
  }

  override async writeFile(): Promise<void> {}
}

function makeLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

async function stdoutOf(tool: BaseTool): Promise<string> {
  const result = (await tool.runAsync({
    args: {command: 'echo'},
    toolContext: makeConfirmedContext(),
  })) as {stdout: string};
  return result.stdout;
}

async function contentOf(tool: BaseTool): Promise<string> {
  const result = (await tool.runAsync({
    args: {path: 'f.txt'},
    toolContext: makeContext(),
  })) as {content: string};
  return result.content;
}

describe('EnvironmentToolset', () => {
  it('returns the four tools in order', async () => {
    const toolset = new EnvironmentToolset({
      environment: new CountingEnvironment(),
    });
    const tools = await toolset.getTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'Execute',
      'ReadFile',
      'EditFile',
      'WriteFile',
    ]);
  });

  it('initializes the environment once across getTools and processLlmRequest', async () => {
    const environment = new CountingEnvironment();
    const toolset = new EnvironmentToolset({environment});

    await toolset.getTools();
    await toolset.getTools();
    await toolset.processLlmRequest(makeContext(), makeLlmRequest());

    expect(environment.initializeCalls).toBe(1);
  });

  it('closes the environment once, and ignores a second close', async () => {
    const environment = new CountingEnvironment();
    const toolset = new EnvironmentToolset({environment});

    await toolset.getTools();
    await toolset.close();
    await toolset.close();

    expect(environment.closeCalls).toBe(1);
  });

  it('does not close an environment it never initialized', async () => {
    const environment = new CountingEnvironment();
    await new EnvironmentToolset({environment}).close();
    expect(environment.closeCalls).toBe(0);
  });

  it('appends an instruction naming the working directory', async () => {
    const environment = new CountingEnvironment();
    const toolset = new EnvironmentToolset({environment});
    const llmRequest = makeLlmRequest();

    await toolset.processLlmRequest(makeContext(), llmRequest);

    expect(llmRequest.config?.systemInstruction).toContain(
      'Your environment is at /tmp/env-under-test/',
    );
    expect(llmRequest.config?.systemInstruction).toContain(
      '# Environment Rules',
    );
  });

  it('appends to an existing system instruction rather than replacing it', async () => {
    const toolset = new EnvironmentToolset({
      environment: new CountingEnvironment(),
    });
    const llmRequest = makeLlmRequest();
    llmRequest.config = {systemInstruction: 'You are helpful.'};

    await toolset.processLlmRequest(makeContext(), llmRequest);

    const instruction = llmRequest.config.systemInstruction as string;
    expect(instruction.startsWith('You are helpful.\n\n')).toBe(true);
    expect(instruction).toContain('Your environment is at');
  });

  it('passes maxOutputChars to Execute and ReadFile only', async () => {
    const toolset = new EnvironmentToolset({
      environment: new CountingEnvironment(),
      maxOutputChars: 10,
    });
    const [executeTool, readFileTool, editFileTool, writeFileTool] =
      await toolset.getTools();

    expect(await stdoutOf(executeTool)).toBe(
      'xxxxxxxxxx\n... (truncated, 50 total chars)',
    );
    expect(await contentOf(readFileTool)).toBe(
      '     1\tyyy\n... (truncated, 57 total chars)',
    );
    // The file tools take no cap, so they expose no truncation to configure.
    expect(editFileTool.name).toBe('EditFile');
    expect(writeFileTool.name).toBe('WriteFile');
  });

  it('defaults to the 30000-character cap when maxOutputChars is omitted', async () => {
    const toolset = new EnvironmentToolset({
      environment: new CountingEnvironment(),
    });
    const [executeTool] = await toolset.getTools();
    expect(await stdoutOf(executeTool)).toBe('x'.repeat(50));
  });

  it('forwards toolFilter and prefix to BaseToolset', () => {
    const toolFilter = ['Execute'];
    const toolset = new EnvironmentToolset({
      environment: new CountingEnvironment(),
      toolFilter,
      prefix: 'sandbox',
    });
    expect(toolset.toolFilter).toBe(toolFilter);
    expect(toolset.prefix).toBe('sandbox');
  });

  it('defaults toolFilter to an empty array and prefix to undefined', () => {
    const toolset = new EnvironmentToolset({
      environment: new CountingEnvironment(),
    });
    expect(toolset.toolFilter).toEqual([]);
    expect(toolset.prefix).toBeUndefined();
  });

  it('builds fresh tool instances on each call', async () => {
    const toolset = new EnvironmentToolset({
      environment: new CountingEnvironment(),
    });
    const first = await toolset.getTools();
    const second = await toolset.getTools();
    expect(first[0]).not.toBe(second[0]);
  });
});
