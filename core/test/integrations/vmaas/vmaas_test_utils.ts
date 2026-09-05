/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Fixtures shared by the Vertex AI sandbox tests. */

import {
  AgentEngineOperation,
  AgentEngineSandboxOperation,
  CreateAgentEngineRequestParameters,
  CreateAgentEngineSandboxRequestParameters,
  GetAgentEngineOperationParameters,
  GetAgentEngineSandboxOperationParameters,
  GetAgentEngineSandboxRequestParameters,
  SandboxEnvironment,
} from '@google-cloud/vertexai/build/src/genai/types.js';
import {
  AgentEngineSandboxApi,
  CdpCommand,
  Context,
  InvocationContext,
  LlmAgent,
  PluginManager,
  SandboxJson,
  createSession,
} from '@google/adk';
import {vi} from 'vitest';

/** The PNG bytes the fake sandbox answers a screenshot request with. */
export const SCREENSHOT_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10,
]);

/** The same bytes, base64-encoded as the CDP response carries them. */
export const SCREENSHOT_BASE64 =
  Buffer.from(SCREENSHOT_BYTES).toString('base64');

/** The page the fake browser sits on. */
export const PAGE_URL = 'https://example.com';

/** The agent engine the fixtures create sandboxes under. */
export const AGENT_ENGINE_NAME =
  'projects/test/locations/us-central1/reasoningEngines/123';

/** A sandbox that lives under {@link AGENT_ENGINE_NAME}. */
export const SANDBOX_NAME = `${AGENT_ENGINE_NAME}/sandboxEnvironments/456`;

/** A template that lives under {@link AGENT_ENGINE_NAME}. */
export const TEMPLATE_NAME = `${AGENT_ENGINE_NAME}/sandboxEnvironmentTemplates/789`;

/** A snapshot that lives under {@link AGENT_ENGINE_NAME}. */
export const SNAPSHOT_NAME = `${AGENT_ENGINE_NAME}/sandboxEnvironmentSnapshots/789`;

/** The service account the fixtures mint tokens with. */
export const SERVICE_ACCOUNT = 'sa@test-project.iam.gserviceaccount.com';

/** The token {@link createFakeTokenProvider} mints. */
export const ACCESS_TOKEN = 'access-token-1';

/** One request the sandbox client sent. */
export interface SandboxCall {
  httpMethod: 'GET' | 'POST';
  path: string;
  accessToken: string;
  sandbox: SandboxEnvironment;
  requestBody?: SandboxJson;
}

/** Options for {@link createFakeSandbox}. */
export interface FakeSandboxOptions {
  /** The URL the fake browser reports for its active tab. */
  url?: string;
  /** What `Page.getNavigationHistory` answers. */
  history?: SandboxJson;
  /** Whether the batch path is served. When false it answers a 404. */
  servesBatchPath?: boolean;
}

/** The command a single-command CDP request carries. */
function commandOf(body: SandboxJson | undefined): string {
  return typeof body?.['command'] === 'string' ? body['command'] : '';
}

/**
 * A sandbox transport that answers the requests the client makes, and records
 * every request it received.
 */
export function createFakeSandbox(options: FakeSandboxOptions = {}) {
  const {
    url = PAGE_URL,
    history = {currentIndex: 1, entries: [{id: 1}, {id: 2}]},
    servesBatchPath = true,
  } = options;
  const calls: SandboxCall[] = [];

  const sendCommand = vi.fn(async (params: SandboxCall) => {
    calls.push(params);
    if (params.path === 'cdps') {
      if (!servesBatchPath) {
        throw new Error('404 Not Found');
      }
      return {body: JSON.stringify({results: [{status: 'success'}]})};
    }
    if (params.path === 'tabs') {
      return {
        body: JSON.stringify({
          active_tab_id: 'tab1',
          all_tabs: [{id: 'tab1', url}],
        }),
      };
    }
    switch (commandOf(params.requestBody)) {
      case 'Page.captureScreenshot':
        return {body: JSON.stringify({data: SCREENSHOT_BASE64})};
      case 'Page.getNavigationHistory':
        return {body: JSON.stringify(history)};
      default:
        return {body: JSON.stringify({})};
    }
  });

  /** The bodies sent to one sandbox path, oldest first. */
  const bodiesTo = (path: string): Array<SandboxJson | undefined> =>
    calls.filter((call) => call.path === path).map((call) => call.requestBody);

  /** The commands of the single batch request sent to the batch path. */
  const batchedCommands = (): CdpCommand[] => {
    const [body] = bodiesTo('cdps');
    const commands = body?.['commands'];
    return Array.isArray(commands) ? (commands as CdpCommand[]) : [];
  };

  return {sendCommand, calls, bodiesTo, batchedCommands};
}

/** Mints {@link ACCESS_TOKEN}, and records the calls that asked for it. */
export function createFakeTokenProvider(token = ACCESS_TOKEN) {
  return vi.fn(
    async (params: {
      sandboxName: string;
      serviceAccountEmail?: string;
      timeoutSeconds: number;
    }) => {
      void params;
      return token;
    },
  );
}

/** Options for {@link createFakeVertexApi}. */
export interface FakeVertexApiOptions {
  /** The engine name the create operation reports. */
  agentEngineName?: string;
  /** The sandbox the create and get calls report. */
  sandbox?: SandboxEnvironment;
}

/**
 * A Vertex AI client whose sandbox calls resolve to the fixtures above.
 *
 * Both create operations report themselves already done, which the backend is
 * free to do and which keeps the suite fast. The pending case that makes both
 * paths poll is driven explicitly in `sandbox_computer_test.ts`.
 */
export function createFakeVertexApi(options: FakeVertexApiOptions = {}) {
  const {
    agentEngineName = AGENT_ENGINE_NAME,
    sandbox = {name: SANDBOX_NAME, displayName: 'adk_computer_use_sandbox'},
  } = options;
  const engineOperation: AgentEngineOperation = {
    name: 'operations/create-engine',
    done: true,
    response: {name: agentEngineName},
  };
  const sandboxOperation: AgentEngineSandboxOperation = {
    name: 'operations/create-sandbox',
    done: true,
    response: sandbox,
  };
  const api = {
    agentEnginesInternal: {
      createInternal: vi.fn(
        async (params: CreateAgentEngineRequestParameters) => {
          void params;
          return engineOperation;
        },
      ),
      getAgentOperationInternal: vi.fn(
        async (params: GetAgentEngineOperationParameters) => {
          void params;
          return engineOperation;
        },
      ),
      sandboxes: {
        getInternal: vi.fn(
          async (params: GetAgentEngineSandboxRequestParameters) => {
            void params;
            return sandbox;
          },
        ),
        createInternal: vi.fn(
          async (params: CreateAgentEngineSandboxRequestParameters) => {
            void params;
            return sandboxOperation;
          },
        ),
        getSandboxOperationInternal: vi.fn(
          async (params: GetAgentEngineSandboxOperationParameters) => {
            void params;
            return sandboxOperation;
          },
        ),
      },
    },
  } satisfies AgentEngineSandboxApi;
  return api;
}

/** A context whose state the computer binds with `prepare()`. */
export function createTestContext(): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'invocation-1',
    agent: new LlmAgent({name: 'computer_agent', model: 'gemini-2.5-flash'}),
    session: createSession({id: 'session-1', appName: 'app', userId: 'user-1'}),
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext});
}
