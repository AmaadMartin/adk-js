/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, FunctionTool, LlmAgent, RunnableRoot} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {vi} from 'vitest';

import {AgentFile, AgentLoader} from '../../src/utils/agent_loader.js';

/** Name of the app every test in this suite serves. */
export const TEST_APP_NAME = 'test_app';

/** The agent the stub loader hands back, drawn by the graph endpoint. */
export const TEST_AGENT = new LlmAgent({
  name: TEST_APP_NAME,
  tools: [
    new FunctionTool({
      name: 'test_tool',
      description: 'a test tool',
      execute: async () => 'result',
    }),
  ],
});

/** Name of the app the stub loader serves wrapped in an {@link App}. */
export const TEST_WRAPPED_APP_NAME = 'wrapped_app';

const TEST_APP = new App({
  name: TEST_WRAPPED_APP_NAME,
  rootAgent: new LlmAgent({name: TEST_WRAPPED_APP_NAME}),
});

/** An {@link AgentFile} that hands back an in-memory agent instead of a file. */
class StubAgentFile extends AgentFile {
  constructor(private readonly loaded: RunnableRoot | App) {
    super('<stub>');
  }

  override async load(): Promise<RunnableRoot | App> {
    return this.loaded;
  }
}

/**
 * Name of an app the loader lists but cannot load, so a route can be driven
 * down its "the app exists but is broken" path.
 */
export const TEST_BROKEN_APP_NAME = 'broken_app';

/**
 * An {@link AgentLoader} serving in-memory apps, so a server can be started
 * without an agent module on disk. One is a bare agent, one is wrapped in an
 * {@link App} which the graph endpoint unwraps, and one fails to load.
 */
export class StubAgentLoader extends AgentLoader {
  override async listAgents(): Promise<string[]> {
    return [TEST_APP_NAME, TEST_WRAPPED_APP_NAME, TEST_BROKEN_APP_NAME];
  }

  override async getAgentFile(agentName: string): Promise<AgentFile> {
    if (agentName === TEST_APP_NAME) {
      return new StubAgentFile(TEST_AGENT);
    }
    if (agentName === TEST_WRAPPED_APP_NAME) {
      return new StubAgentFile(TEST_APP);
    }

    throw new Error(`Agent '${agentName}' not found`);
  }
}

/**
 * One loader shared by every test. `AgentLoader`'s constructor registers
 * process exit listeners, so building one per test would exceed Node's
 * listener warning threshold.
 */
export const STUB_AGENT_LOADER = new StubAgentLoader();

export interface HttpResponse {
  status: number;
  /** The parsed JSON body, or `undefined` when the response carried none. */
  body: unknown;
  text: string;
}

/** Drives a running server over real HTTP, reporting the status as given. */
export class TestHttpClient {
  constructor(private readonly baseUrl: string) {}

  get(url: string): Promise<HttpResponse> {
    return this.request('GET', url);
  }

  post(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResponse> {
    return this.request('POST', url, body, headers);
  }

  put(url: string, body: unknown): Promise<HttpResponse> {
    return this.request('PUT', url, body);
  }

  delete(url: string): Promise<HttpResponse> {
    return this.request('DELETE', url);
  }

  private async request(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<HttpResponse> {
    const response = await fetch(`${this.baseUrl}${url}`, {
      method,
      headers:
        body === undefined
          ? headers
          : {'Content-Type': 'application/json', ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await response.text();

    let parsed: unknown = undefined;
    if (response.headers.get('content-type')?.includes('application/json')) {
      parsed = JSON.parse(text);
    }

    return {status: response.status, body: parsed, text};
  }
}

/** Creates a private temporary agents directory. */
export function makeAgentsDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'adk-dev-server-test-'));
}

/**
 * Points the ADK config file at a temporary home directory, so a test never
 * writes to the real one. `os.homedir()` reads `HOME` on POSIX and
 * `USERPROFILE` on Windows, so both are stubbed.
 */
export function stubHomeDir(homeDir: string): void {
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('USERPROFILE', homeDir);
}

/** Returns the tests directory of an app inside an agents directory. */
export function testsDirOf(agentsDir: string, appName: string): string {
  return path.join(agentsDir, appName, 'tests');
}

/** Writes a test fixture file under `<agentsDir>/<appName>/tests`. */
export async function writeTestFile(
  agentsDir: string,
  appName: string,
  fileName: string,
  contents: string,
): Promise<string> {
  const testsDir = testsDirOf(agentsDir, appName);
  await fs.mkdir(testsDir, {recursive: true});
  const filePath = path.join(testsDir, fileName);
  await fs.writeFile(filePath, contents, 'utf-8');

  return filePath;
}
