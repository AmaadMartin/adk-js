/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Fixtures shared by the vmaas sandbox tests. */

import {Client} from '@google-cloud/vertexai';
import {
  Context,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {vi} from 'vitest';

/** The PNG bytes the fake sandbox returns for a screenshot. */
export const SCREENSHOT_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10,
]);

/** The same bytes, base64-encoded the way the CDP response carries them. */
export const SCREENSHOT_BASE64 =
  Buffer.from(SCREENSHOT_BYTES).toString('base64');

/** The page the fake browser sits on. */
export const PAGE_URL = 'https://example.com';

/** The agent engine the fixtures create sandboxes under. */
export const AGENT_ENGINE_NAME =
  'projects/test/locations/us-central1/reasoningEngines/123';

/** A sandbox that lives under {@link AGENT_ENGINE_NAME}. */
export const SANDBOX_NAME = `${AGENT_ENGINE_NAME}/sandboxEnvironments/456`;

/** One request the sandbox client sent. */
export interface SandboxCall {
  httpMethod: 'GET' | 'POST';
  path: string;
  accessToken: string;
  sandbox: {name?: string};
  requestBody?: Record<string, unknown>;
}

/** Options for {@link createFakeSandbox}. */
export interface FakeSandboxOptions {
  /** The URL the fake browser reports as the active tab's. */
  url?: string;
  /** The navigation history `Page.getNavigationHistory` returns. */
  history?: {currentIndex: number; entries: Array<{id: number}>};
  /** Whether the batch path is served. When false it fails with a 404. */
  batchPathAvailable?: boolean;
}

/** The command carried by a single-command CDP request. */
function cdpCommandOf(body: Record<string, unknown> | undefined): string {
  return typeof body?.['command'] === 'string' ? body['command'] : '';
}

/**
 * A sandbox transport that answers the CDP requests the client makes, and
 * records every request it received.
 */
export function createFakeSandbox(options: FakeSandboxOptions = {}) {
  const {
    url = PAGE_URL,
    history = {currentIndex: 1, entries: [{id: 1}, {id: 2}]},
    batchPathAvailable = true,
  } = options;
  const calls: SandboxCall[] = [];

  const sendCommand = vi.fn(async (params: SandboxCall) => {
    calls.push(params);
    if (params.path === 'cdps') {
      if (!batchPathAvailable) {
        throw new Error('404 Not Found');
      }
      return {body: JSON.stringify({results: []})};
    }
    if (params.path === 'tabs') {
      return {
        body: JSON.stringify({
          active_tab_id: 'tab1',
          all_tabs: [{id: 'tab1', url}],
        }),
      };
    }
    switch (cdpCommandOf(params.requestBody)) {
      case 'Page.captureScreenshot':
        return {body: JSON.stringify({data: SCREENSHOT_BASE64})};
      case 'Page.getNavigationHistory':
        return {body: JSON.stringify(history)};
      default:
        return {body: JSON.stringify({})};
    }
  });

  return {sendCommand, calls};
}

/** The `agentEnginesInternal` surface the computer calls. */
export interface MockVertexClient {
  agentEnginesInternal: {
    createInternal: ReturnType<typeof vi.fn>;
    getAgentOperationInternal: ReturnType<typeof vi.fn>;
    sandboxes: {
      getInternal: ReturnType<typeof vi.fn>;
      createInternal: ReturnType<typeof vi.fn>;
    };
  };
}

/** A Vertex AI client whose sandbox calls resolve to the fixtures above. */
export function createMockVertexClient(): MockVertexClient {
  return {
    agentEnginesInternal: {
      createInternal: vi.fn().mockResolvedValue({
        name: 'operations/create-engine-op',
        done: true,
        response: {name: AGENT_ENGINE_NAME},
      }),
      getAgentOperationInternal: vi.fn().mockResolvedValue({
        name: 'operations/create-engine-op',
        done: true,
        response: {name: AGENT_ENGINE_NAME},
      }),
      sandboxes: {
        getInternal: vi.fn().mockResolvedValue({name: SANDBOX_NAME}),
        createInternal: vi.fn().mockResolvedValue({
          name: 'operations/create-sandbox-op',
          done: true,
          response: {name: SANDBOX_NAME},
        }),
      },
    },
  };
}

/**
 * Presents a mock as the Vertex AI client.
 *
 * `Client` is a third-party class with a large surface the computer never
 * touches, so the cast lives here once instead of at every call site.
 */
export function asVertexClient(mock: MockVertexClient): Client {
  return mock as unknown as Client;
}

/** A tool context whose state the computer can bind with `prepare()`. */
export function createTestContext(): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'computer_agent', model: 'gemini-2.5-flash'}),
    session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext});
}
