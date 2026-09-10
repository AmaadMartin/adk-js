/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseEnvironment, ExecutionResult} from '@google/adk';

/** A missing-file error shaped the way Node reports one. */
class FileNotFoundError extends Error {
  readonly code = 'ENOENT';
  constructor(filePath: string) {
    super(`ENOENT: no such file or directory, open '${filePath}'`);
    this.name = 'Error';
  }
}

/** Options for {@link FakeEnvironment}. */
export interface FakeEnvironmentOptions {
  workingDir?: string;
  /** The result every `execute` call returns. */
  result?: ExecutionResult;
  /** Thrown by `readFile` instead of reading, to exercise the error path. */
  readFileError?: Error;
  /** Thrown by `writeFile` instead of writing, to exercise the error path. */
  writeFileError?: Error;
  /** Awaited inside `writeFile`, so a test can observe concurrent writes. */
  onWrite?: () => Promise<void>;
}

/**
 * An in-memory {@link BaseEnvironment} that records what the skill tools ask
 * of it. Used instead of a real sandbox where the test is about the tool's
 * behaviour rather than about running a command.
 */
export class FakeEnvironment extends BaseEnvironment {
  readonly files = new Map<string, string>();
  readonly executeCalls: Array<{command: string; timeoutSeconds?: number}> = [];
  readonly writeCalls: Array<{filePath: string; content: string}> = [];
  initializeCount = 0;
  closeCount = 0;
  /** Thrown by `execute` instead of running, to exercise the error path. */
  executeError?: Error;

  constructor(private readonly options: FakeEnvironmentOptions = {}) {
    super();
  }

  override get workingDir(): string {
    return this.options.workingDir ?? '/workspace';
  }

  override async initialize(): Promise<void> {
    this.initializeCount++;
    this.initialized = true;
  }

  override async close(): Promise<void> {
    this.closeCount++;
    this.initialized = false;
  }

  override async execute(
    command: string,
    timeoutSeconds?: number,
  ): Promise<ExecutionResult> {
    this.executeCalls.push({command, timeoutSeconds});
    if (this.executeError) {
      throw this.executeError;
    }
    return (
      this.options.result ?? {
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
      }
    );
  }

  override async readFile(filePath: string): Promise<Uint8Array> {
    if (this.options.readFileError) {
      throw this.options.readFileError;
    }
    const content = this.files.get(filePath);
    if (content === undefined) {
      throw new FileNotFoundError(filePath);
    }
    return new TextEncoder().encode(content);
  }

  override async writeFile(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    if (this.options.writeFileError) {
      throw this.options.writeFileError;
    }
    const text =
      typeof content === 'string' ? content : new TextDecoder().decode(content);
    this.writeCalls.push({filePath, content: text});
    await this.options.onWrite?.();
    this.files.set(filePath, text);
  }
}
