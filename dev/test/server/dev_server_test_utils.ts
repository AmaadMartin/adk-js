/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionTool, LlmAgent, RunnableRoot} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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

/** An {@link AgentFile} that hands back an in-memory agent instead of a file. */
class StubAgentFile extends AgentFile {
  constructor(private readonly stubAgent: RunnableRoot) {
    super('<stub>');
  }

  override async load(): Promise<RunnableRoot> {
    return this.stubAgent;
  }
}

/**
 * An {@link AgentLoader} serving one in-memory agent, so a server can be
 * started without an agent module on disk.
 */
export class StubAgentLoader extends AgentLoader {
  override async listAgents(): Promise<string[]> {
    return [TEST_APP_NAME];
  }

  override async getAgentFile(agentName: string): Promise<AgentFile> {
    if (agentName !== TEST_APP_NAME) {
      throw new Error(`Agent '${agentName}' not found`);
    }

    return new StubAgentFile(TEST_AGENT);
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
