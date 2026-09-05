/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-python reference tests for `AgentEngineSandboxComputer`, ported to
 * TypeScript. Each `it(...)` keeps its Python name verbatim, so a reviewer can
 * match the two suites by grep.
 *
 * Source: adk-python `main`,
 * `tests/unittests/integrations/vmaas/test_sandbox_computer.py`.
 *
 * adk-python patches private methods and `asyncio.to_thread`. adk-js has
 * neither, so the tests drive the same behaviour through the injected Vertex
 * AI client, the access token provider and the sandbox transport.
 */

import {
  AgentEngineSandboxComputer,
  ComputerEnvironment,
  Context,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

import {
  AGENT_ENGINE_NAME,
  PAGE_URL,
  SANDBOX_NAME,
  SCREENSHOT_BYTES,
  SandboxCall,
  asVertexClient,
  createFakeSandbox,
  createMockVertexClient,
  createTestContext,
} from './vmaas_test_utils.js';

const PROJECT_ID = 'test-project';
const SERVICE_ACCOUNT = 'sa@test-project.iam.gserviceaccount.com';
const TEMPLATE_NAME = `${AGENT_ENGINE_NAME}/sandboxEnvironmentTemplates/789`;
const SNAPSHOT_NAME = `${AGENT_ENGINE_NAME}/sandboxEnvironmentSnapshots/789`;

/** The session state keys adk-python writes, byte for byte. */
const STATE_KEY_AGENT_ENGINE_NAME = '_vmaas_agent_engine_name';
const STATE_KEY_SANDBOX_NAME = '_vmaas_sandbox_name';
const STATE_KEY_ACCESS_TOKEN = '_vmaas_access_token';
const STATE_KEY_TOKEN_EXPIRY = '_vmaas_token_expiry';

const ACCESS_TOKEN = 'test_token';

interface Harness {
  computer: AgentEngineSandboxComputer;
  context: Context;
  vertexClient: ReturnType<typeof createMockVertexClient>;
  sandbox: ReturnType<typeof createFakeSandbox>;
  accessTokenProvider: ReturnType<typeof vi.fn>;
}

/** Builds a computer wired to the fixtures, with its session state bound. */
async function createHarness(
  options: {
    sandboxName?: string;
    sandboxTemplateName?: string;
    sandboxSnapshotName?: string;
    searchEngineUrl?: string;
    history?: {currentIndex: number; entries: Array<{id: number}>};
  } = {},
): Promise<Harness> {
  const vertexClient = createMockVertexClient();
  const sandbox = createFakeSandbox({history: options.history});
  const accessTokenProvider = vi.fn().mockResolvedValue(ACCESS_TOKEN);
  const computer = new AgentEngineSandboxComputer({
    projectId: PROJECT_ID,
    serviceAccountEmail: SERVICE_ACCOUNT,
    sandboxName: options.sandboxName,
    sandboxTemplateName: options.sandboxTemplateName,
    sandboxSnapshotName: options.sandboxSnapshotName,
    searchEngineUrl: options.searchEngineUrl,
    vertexaiClient: asVertexClient(vertexClient),
    accessTokenProvider,
    sendCommand: sandbox.sendCommand,
  });
  const context = createTestContext();
  await computer.prepare(context);
  return {computer, context, vertexClient, sandbox, accessTokenProvider};
}

/** The parameters of the single CDP command the sandbox received. */
function cdpParamsOf(call: SandboxCall): Record<string, unknown> {
  const body = call.requestBody as {params: Record<string, unknown>};
  return body.params;
}

/** The requests that carried the named CDP command. */
function callsForCommand(calls: SandboxCall[], command: string): SandboxCall[] {
  return calls.filter(
    (call) => call.path === 'cdp' && call.requestBody?.['command'] === command,
  );
}

/** The commands of every batch request the sandbox received. */
function batchedCommands(
  calls: SandboxCall[],
): Array<Array<{command: string; params: Record<string, unknown>}>> {
  return calls
    .filter((call) => call.path === 'cdps')
    .map(
      (call) =>
        call.requestBody?.['commands'] as Array<{
          command: string;
          params: Record<string, unknown>;
        }>,
    );
}

describe('AgentEngineSandboxComputer parity with adk-python', () => {
  it('test_init', async () => {
    const {computer, accessTokenProvider} = await createHarness();

    expect(await computer.screenSize()).toEqual([1280, 720]);

    await computer.currentState();

    expect(accessTokenProvider).toHaveBeenCalledWith(
      expect.objectContaining({serviceAccountEmail: SERVICE_ACCOUNT}),
    );
  });

  it('test_init_with_byos', () => {
    const computer = new AgentEngineSandboxComputer({
      projectId: PROJECT_ID,
      sandboxName: SANDBOX_NAME,
    });

    expect(computer.agentEngineName).toBe(AGENT_ENGINE_NAME);
    expect(computer.sandboxName).toBe(SANDBOX_NAME);
  });

  it('test_init_with_template_derives_agent_engine', () => {
    const computer = new AgentEngineSandboxComputer({
      projectId: PROJECT_ID,
      sandboxTemplateName: TEMPLATE_NAME,
    });

    expect(computer.agentEngineName).toBe(AGENT_ENGINE_NAME);
    expect(computer.sandboxTemplateName).toBe(TEMPLATE_NAME);
  });

  it('test_init_with_snapshot_derives_agent_engine', () => {
    const computer = new AgentEngineSandboxComputer({
      projectId: PROJECT_ID,
      sandboxSnapshotName: SNAPSHOT_NAME,
    });

    expect(computer.agentEngineName).toBe(AGENT_ENGINE_NAME);
    expect(computer.sandboxSnapshotName).toBe(SNAPSHOT_NAME);
  });

  it('test_init_sandbox_name_takes_precedence_over_template', () => {
    const sandboxEngine =
      'projects/test/locations/us-central1/reasoningEngines/sandbox';

    const computer = new AgentEngineSandboxComputer({
      projectId: PROJECT_ID,
      sandboxName: `${sandboxEngine}/sandboxEnvironments/456`,
      sandboxTemplateName:
        'projects/test/locations/us-central1/reasoningEngines/template' +
        '/sandboxEnvironmentTemplates/789',
    });

    expect(computer.agentEngineName).toBe(sandboxEngine);
  });

  it('test_init_without_sandbox_source_has_no_agent_engine', () => {
    const computer = new AgentEngineSandboxComputer({projectId: PROJECT_ID});

    expect(computer.agentEngineName).toBeUndefined();
  });

  it('test_ensure_agent_engine_with_template_name', async () => {
    const {computer, context, vertexClient} = await createHarness({
      sandboxTemplateName: TEMPLATE_NAME,
    });

    await computer.currentState();

    expect(
      vertexClient.agentEnginesInternal.sandboxes.createInternal,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        name: AGENT_ENGINE_NAME,
        config: expect.objectContaining({
          sandboxEnvironmentTemplate: TEMPLATE_NAME,
        }),
      }),
    );
    expect(
      vertexClient.agentEnginesInternal.createInternal,
    ).not.toHaveBeenCalled();
    expect(context.state.has(STATE_KEY_AGENT_ENGINE_NAME)).toBe(false);
  });

  it('test_init_with_vertexai_client', async () => {
    const {computer, vertexClient} = await createHarness({
      sandboxName: SANDBOX_NAME,
    });

    await computer.currentState();

    expect(
      vertexClient.agentEnginesInternal.sandboxes.getInternal,
    ).toHaveBeenCalledWith({name: SANDBOX_NAME});
  });

  it('test_screen_size', async () => {
    const computer = new AgentEngineSandboxComputer();

    expect(await computer.screenSize()).toEqual([1280, 720]);
  });

  it('test_environment', async () => {
    const computer = new AgentEngineSandboxComputer();

    expect(await computer.environment()).toBe(
      ComputerEnvironment.ENVIRONMENT_BROWSER,
    );
  });

  it('test_ensure_agent_engine_with_sandbox_name', async () => {
    const {computer, context, vertexClient} = await createHarness({
      sandboxName: SANDBOX_NAME,
    });

    await computer.currentState();

    expect(
      vertexClient.agentEnginesInternal.createInternal,
    ).not.toHaveBeenCalled();
    expect(context.state.has(STATE_KEY_AGENT_ENGINE_NAME)).toBe(false);
  });

  it('test_ensure_agent_engine_from_session_state', async () => {
    const existingEngine =
      'projects/test/locations/us-central1/reasoningEngines/999';
    const {computer, context, vertexClient} = await createHarness();
    context.state.set(STATE_KEY_AGENT_ENGINE_NAME, existingEngine);

    await computer.currentState();

    expect(
      vertexClient.agentEnginesInternal.createInternal,
    ).not.toHaveBeenCalled();
    expect(
      vertexClient.agentEnginesInternal.sandboxes.createInternal,
    ).toHaveBeenCalledWith(expect.objectContaining({name: existingEngine}));
  });

  it('test_ensure_agent_engine_creates_new', async () => {
    const {computer, context, vertexClient} = await createHarness();

    await computer.currentState();

    expect(
      vertexClient.agentEnginesInternal.createInternal,
    ).toHaveBeenCalledTimes(1);
    expect(context.state.get(STATE_KEY_AGENT_ENGINE_NAME)).toBe(
      AGENT_ENGINE_NAME,
    );
  });

  it('test_get_sandbox_with_constructor_value', async () => {
    const {computer, context, vertexClient} = await createHarness({
      sandboxName: SANDBOX_NAME,
    });

    await computer.currentState();

    expect(
      vertexClient.agentEnginesInternal.sandboxes.getInternal,
    ).toHaveBeenCalledWith({name: SANDBOX_NAME});
    expect(context.state.has(STATE_KEY_SANDBOX_NAME)).toBe(false);
  });

  it('test_get_sandbox_from_session_state', async () => {
    const existingSandbox = `${AGENT_ENGINE_NAME}/sandboxEnvironments/999`;
    const {computer, context, vertexClient} = await createHarness();
    context.state.set(STATE_KEY_SANDBOX_NAME, existingSandbox);

    await computer.currentState();

    expect(
      vertexClient.agentEnginesInternal.sandboxes.getInternal,
    ).toHaveBeenCalledWith({name: existingSandbox});
    expect(
      vertexClient.agentEnginesInternal.sandboxes.createInternal,
    ).not.toHaveBeenCalled();
  });

  it('test_get_access_token_cached', async () => {
    const {computer, context, accessTokenProvider, sandbox} =
      await createHarness({sandboxName: SANDBOX_NAME});
    context.state.set(STATE_KEY_ACCESS_TOKEN, 'cached_token_123');
    context.state.set(STATE_KEY_TOKEN_EXPIRY, Date.now() / 1000 + 3600);

    await computer.currentState();

    expect(accessTokenProvider).not.toHaveBeenCalled();
    expect(sandbox.calls[0].accessToken).toBe('cached_token_123');
  });

  it('test_get_access_token_generates_new_when_expired', async () => {
    const {computer, context, accessTokenProvider} = await createHarness({
      sandboxName: SANDBOX_NAME,
    });
    context.state.set(STATE_KEY_ACCESS_TOKEN, 'old_token');
    context.state.set(STATE_KEY_TOKEN_EXPIRY, Date.now() / 1000 - 100);
    accessTokenProvider.mockResolvedValue('new_token_456');

    await computer.currentState();

    expect(accessTokenProvider).toHaveBeenCalled();
    expect(context.state.get(STATE_KEY_ACCESS_TOKEN)).toBe('new_token_456');
  });

  it('test_click_at', async () => {
    const {computer, sandbox} = await createHarness();

    const result = await computer.clickAt({x: 100, y: 200});

    expect(batchedCommands(sandbox.calls)[0]).toEqual([
      {
        command: 'Input.dispatchMouseEvent',
        params: {
          type: 'mousePressed',
          button: 'left',
          x: 100,
          y: 200,
          clickCount: 1,
        },
      },
      {
        command: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseReleased',
          button: 'left',
          x: 100,
          y: 200,
          clickCount: 1,
        },
      },
    ]);
    expect(Array.from(result.screenshot!)).toEqual(
      Array.from(SCREENSHOT_BYTES),
    );
    expect(result.url).toBe(PAGE_URL);
  });

  it('test_hover_at', async () => {
    const {computer, sandbox} = await createHarness();

    const result = await computer.hoverAt({x: 150, y: 250});

    expect(
      cdpParamsOf(
        callsForCommand(sandbox.calls, 'Input.dispatchMouseEvent')[0],
      ),
    ).toEqual({type: 'mouseMoved', x: 150, y: 250});
    expect(result.url).toBe(PAGE_URL);
  });

  it('test_type_text_at', async () => {
    const {computer, sandbox} = await createHarness();

    const result = await computer.typeTextAt({
      x: 100,
      y: 200,
      text: 'hello',
      pressEnter: true,
      clearBeforeTyping: false,
    });

    const batches = batchedCommands(sandbox.calls);
    expect(batches[0][0].params['type']).toBe('mousePressed');
    expect(batches[1].map((entry) => entry.command)).toEqual([
      'Input.insertText',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
    ]);
    expect(batches[1][0].params).toEqual({text: 'hello'});
    expect(result.url).toBe(PAGE_URL);
  });

  it('test_scroll_document', async () => {
    const {computer, sandbox} = await createHarness();

    const result = await computer.scrollDocument({direction: 'down'});

    expect(
      cdpParamsOf(
        callsForCommand(sandbox.calls, 'Input.dispatchMouseEvent')[0],
      ),
    ).toEqual({type: 'mouseWheel', x: 640, y: 360, deltaX: 0, deltaY: 400});
    expect(result.url).toBe(PAGE_URL);
  });

  it('test_scroll_at', async () => {
    const {computer, sandbox} = await createHarness();

    const result = await computer.scrollAt({
      x: 100,
      y: 200,
      direction: 'up',
      magnitude: 500,
    });

    expect(
      cdpParamsOf(
        callsForCommand(sandbox.calls, 'Input.dispatchMouseEvent')[0],
      ),
    ).toEqual({type: 'mouseWheel', x: 100, y: 200, deltaX: 0, deltaY: -500});
    expect(result.url).toBe(PAGE_URL);
  });

  it('test_navigate', async () => {
    const {computer, sandbox} = await createHarness();

    const result = await computer.navigate({url: 'https://newsite.com'});

    expect(
      cdpParamsOf(callsForCommand(sandbox.calls, 'Page.navigate')[0]),
    ).toEqual({url: 'https://newsite.com'});
    expect(result.url).toBe(PAGE_URL);
  });

  it('test_search', async () => {
    const {computer, sandbox} = await createHarness({
      searchEngineUrl: 'https://www.google.com',
    });

    const result = await computer.search();

    expect(
      cdpParamsOf(callsForCommand(sandbox.calls, 'Page.navigate')[0]),
    ).toEqual({url: 'https://www.google.com'});
    expect(result.url).toBe(PAGE_URL);
  });

  it('test_go_back', async () => {
    const {computer, sandbox} = await createHarness({
      history: {currentIndex: 1, entries: [{id: 11}, {id: 22}]},
    });

    const result = await computer.goBack();

    expect(
      cdpParamsOf(
        callsForCommand(sandbox.calls, 'Page.navigateToHistoryEntry')[0],
      ),
    ).toEqual({entryId: 11});
    expect(result.url).toBe(PAGE_URL);
  });

  it('test_go_forward', async () => {
    const {computer, sandbox} = await createHarness({
      history: {currentIndex: 0, entries: [{id: 11}, {id: 22}]},
    });

    const result = await computer.goForward();

    expect(
      cdpParamsOf(
        callsForCommand(sandbox.calls, 'Page.navigateToHistoryEntry')[0],
      ),
    ).toEqual({entryId: 22});
    expect(result.url).toBe(PAGE_URL);
  });

  it('test_key_combination', async () => {
    const {computer, sandbox} = await createHarness();

    const result = await computer.keyCombination({keys: ['control', 'c']});

    expect(batchedCommands(sandbox.calls)[0]).toEqual([
      {
        command: 'Input.dispatchKeyEvent',
        params: {type: 'keyDown', key: 'Control_L'},
      },
      {command: 'Input.dispatchKeyEvent', params: {type: 'keyDown', text: 'c'}},
      {command: 'Input.dispatchKeyEvent', params: {type: 'keyUp', text: 'c'}},
      {
        command: 'Input.dispatchKeyEvent',
        params: {type: 'keyUp', key: 'Control_L'},
      },
    ]);
    expect(result.url).toBe(PAGE_URL);
  });

  it('test_drag_and_drop', async () => {
    const {computer, sandbox} = await createHarness();

    const result = await computer.dragAndDrop({
      x: 10,
      y: 20,
      destinationX: 100,
      destinationY: 200,
    });

    expect(
      batchedCommands(sandbox.calls)[0].map((entry) => entry.params),
    ).toEqual([
      {type: 'mouseMoved', x: 10, y: 20},
      {type: 'mousePressed', button: 'left', x: 10, y: 20, clickCount: 1},
      {type: 'mouseMoved', x: 100, y: 200},
      {type: 'mouseReleased', button: 'left', x: 100, y: 200, clickCount: 1},
    ]);
    expect(result.url).toBe(PAGE_URL);
  });

  it('test_wait', async () => {
    const {computer} = await createHarness();
    vi.useFakeTimers();
    try {
      const start = Date.now();

      const pending = computer.wait({seconds: 1});
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;

      expect(Date.now() - start).toBeGreaterThanOrEqual(1000);
      expect(result.url).toBe(PAGE_URL);
    } finally {
      vi.useRealTimers();
    }
  });

  it('test_current_state', async () => {
    const {computer} = await createHarness();

    const result = await computer.currentState();

    expect(Array.from(result.screenshot!)).toEqual(
      Array.from(SCREENSHOT_BYTES),
    );
    expect(result.url).toBe(PAGE_URL);
  });

  it('test_open_web_browser', async () => {
    const {computer, sandbox} = await createHarness();

    const result = await computer.openWebBrowser();

    expect(Array.from(result.screenshot!)).toEqual(
      Array.from(SCREENSHOT_BYTES),
    );
    expect(batchedCommands(sandbox.calls)).toEqual([]);
  });

  it('test_initialize_is_noop', async () => {
    const {computer, sandbox, vertexClient} = await createHarness();

    await computer.initialize();

    expect(sandbox.sendCommand).not.toHaveBeenCalled();
    expect(
      vertexClient.agentEnginesInternal.sandboxes.createInternal,
    ).not.toHaveBeenCalled();
  });

  it('test_close_is_noop', async () => {
    const {computer, sandbox, vertexClient} = await createHarness({
      sandboxName: SANDBOX_NAME,
    });
    await computer.currentState();
    sandbox.sendCommand.mockClear();

    await computer.close();

    expect(sandbox.sendCommand).not.toHaveBeenCalled();
    expect(
      vertexClient.agentEnginesInternal.sandboxes.getInternal,
    ).toHaveBeenCalled();
  });
});
