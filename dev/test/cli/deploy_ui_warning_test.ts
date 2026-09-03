/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Console} from 'node:console';
import {Writable} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  deployToAgentEngine,
  DeployToAgentEngineOptions,
} from '../../src/cli/deploy/cli_deploy_agent_engine.js';
import {
  ADK_WEB_WARNING,
  warnIfWithUi,
} from '../../src/cli/deploy/deploy_utils.js';

const EXPECTED_LINE = `WARNING: ${ADK_WEB_WARNING}\n`;

/** Collects everything written to it, so a test can assert on one stream. */
class CaptureStream extends Writable {
  readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }
}

const realConsole = globalThis.console;
let stdout: CaptureStream;
let stderr: CaptureStream;

beforeEach(() => {
  stdout = new CaptureStream();
  stderr = new CaptureStream();
  globalThis.console = new Console({stdout, stderr});
});

afterEach(() => {
  globalThis.console = realConsole;
});

/**
 * Options that reach the repository guard without touching gcloud or the
 * filesystem: the project and the region are supplied, the repository is not.
 */
function agentEngineOptions(withUi: boolean): DeployToAgentEngineOptions {
  return {
    agentPath: '/nonexistent/agent',
    project: 'test-project',
    region: 'us-central1',
    port: 8080,
    withUi,
    logLevel: 'info',
    adkVersion: 'latest',
  };
}

describe('warnIfWithUi', () => {
  it('writes the ADK Web warning to stderr when the UI is shipped', () => {
    warnIfWithUi(true);

    expect(stderr.chunks).toEqual([EXPECTED_LINE]);
    expect(stdout.chunks).toEqual([]);
  });

  it('writes nothing when the UI is not shipped', () => {
    warnIfWithUi(false);

    expect(stderr.chunks).toEqual([]);
    expect(stdout.chunks).toEqual([]);
  });
});

describe('deployToAgentEngine', () => {
  it('warns about ADK Web before it validates the deployment options', async () => {
    await expect(deployToAgentEngine(agentEngineOptions(true))).rejects.toThrow(
      /Artifact Registry repository is not specified/,
    );

    expect(stderr.chunks).toEqual([EXPECTED_LINE]);
  });

  it('does not warn about ADK Web when the UI is not shipped', async () => {
    await expect(
      deployToAgentEngine(agentEngineOptions(false)),
    ).rejects.toThrow(/Artifact Registry repository is not specified/);

    expect(stderr.chunks).toEqual([]);
  });
});
