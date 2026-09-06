/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseEnvironment,
  Context,
  ExecutionResult,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ToolConfirmation,
  createSession,
} from '@google/adk';
import {expect} from 'vitest';

/**
 * Builds a real `Context` for a tool call.
 *
 * The Python reference tests pass `tool_context=None`. adk-js types the field
 * as `Context`, so the tests build one from real `InvocationContext`, `LlmAgent`
 * and session objects instead of casting.
 */
export function makeContext(
  options: {
    functionCallId?: string;
    toolConfirmation?: ToolConfirmation;
  } = {},
): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'environment_agent', model: 'gemini-2.5-flash'}),
    session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
    pluginManager: new PluginManager([]),
  });
  return new Context({
    invocationContext,
    functionCallId: 'fc-1',
    ...options,
  });
}

/** A `Context` whose tool call is already approved. */
export function makeConfirmedContext(): Context {
  return makeContext({
    toolConfirmation: new ToolConfirmation({confirmed: true}),
  });
}

/** A `Context` whose tool call the client has refused. */
export function makeRejectedContext(): Context {
  return makeContext({
    toolConfirmation: new ToolConfirmation({confirmed: false}),
  });
}

/**
 * An environment that records every `execute` call and returns a scripted
 * result. Fields left out of `result` default to a successful, silent run.
 */
export class RecordingEnvironment extends BaseEnvironment {
  /** The commands passed to {@link execute}, in call order. */
  readonly commands: string[] = [];

  /** The timeout passed to {@link execute}, in call order. */
  readonly timeouts: Array<number | undefined> = [];

  constructor(private readonly result: Partial<ExecutionResult> = {}) {
    super();
  }

  override get workingDir(): string {
    return '/workspace';
  }

  override async execute(
    command: string,
    timeoutSeconds?: number,
  ): Promise<ExecutionResult> {
    this.commands.push(command);
    this.timeouts.push(timeoutSeconds);
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      ...this.result,
    };
  }

  override async readFile(): Promise<Uint8Array> {
    expect.fail('readFile is not part of the ExecuteTool contract');
  }

  override async writeFile(): Promise<void> {
    expect.fail('writeFile is not part of the ExecuteTool contract');
  }
}

/** An environment whose `execute` rejects, to drive the error path. */
export class FailingEnvironment extends BaseEnvironment {
  constructor(private readonly failure: Error) {
    super();
  }

  override get workingDir(): string {
    return '/workspace';
  }

  override async execute(): Promise<ExecutionResult> {
    throw this.failure;
  }

  override async readFile(): Promise<Uint8Array> {
    expect.fail('readFile is not part of the ExecuteTool contract');
  }

  override async writeFile(): Promise<void> {
    expect.fail('writeFile is not part of the ExecuteTool contract');
  }
}
