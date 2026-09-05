/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The reference suite for AgentEngineSandboxComputer, ported test by test from
 * adk-python `main`, `tests/unittests/integrations/vmaas/test_sandbox_computer.py`.
 *
 * Each `it` keeps its Python test name, so the two suites can be read side by
 * side. The Python tests assign private fields and patch private methods; these
 * drive the same behaviour through the constructor, `prepare()` and the two
 * injected transports, because adk-js tests may not reach into a private.
 */

import {
  AgentEngineSandboxComputer,
  ComputerEnvironment,
  Context,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  ACCESS_TOKEN,
  AGENT_ENGINE_NAME,
  PAGE_URL,
  SANDBOX_NAME,
  SCREENSHOT_BYTES,
  SERVICE_ACCOUNT,
  SNAPSHOT_NAME,
  TEMPLATE_NAME,
  createFakeSandbox,
  createFakeTokenProvider,
  createFakeVertexApi,
  createTestContext,
} from './vmaas_test_utils.js';

const PROJECT_ID = 'test-project';
const LOCATION = 'us-central1';
const STATE_KEY_AGENT_ENGINE_NAME = '_vmaas_agent_engine_name';
const STATE_KEY_SANDBOX_NAME = '_vmaas_sandbox_name';
const STATE_KEY_ACCESS_TOKEN = '_vmaas_access_token';
const STATE_KEY_TOKEN_EXPIRY = '_vmaas_token_expiry';

/** A computer wired to the fakes, and the fakes it was wired to. */
function createComputer(
  options: Partial<{
    sandboxName: string;
    sandboxTemplateName: string;
    sandboxSnapshotName: string;
    searchEngineUrl: string;
    serviceAccountEmail: string;
    history: Record<string, unknown>;
  }> = {},
) {
  const {history, ...computerOptions} = options;
  const vertexApi = createFakeVertexApi();
  const sandbox = createFakeSandbox(history ? {history} : {});
  const accessTokenProvider = createFakeTokenProvider();
  const computer = new AgentEngineSandboxComputer({
    projectId: PROJECT_ID,
    vertexaiClient: vertexApi,
    accessTokenProvider,
    sendCommand: sandbox.sendCommand,
    ...computerOptions,
  });
  return {computer, vertexApi, sandbox, accessTokenProvider};
}

/** A computer that already has its session state bound. */
async function createPreparedComputer(
  options: Parameters<typeof createComputer>[0] = {},
): Promise<ReturnType<typeof createComputer> & {context: Context}> {
  const wired = createComputer(options);
  const context = createTestContext();
  await wired.computer.prepare(context);
  return {...wired, context};
}

describe('AgentEngineSandboxComputer parity with adk-python', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('test_init', async () => {
    const sandbox = createFakeSandbox();
    const accessTokenProvider = createFakeTokenProvider();
    const computer = new AgentEngineSandboxComputer({
      projectId: PROJECT_ID,
      location: LOCATION,
      serviceAccountEmail: SERVICE_ACCOUNT,
      vertexaiClient: createFakeVertexApi(),
      accessTokenProvider,
      sendCommand: sandbox.sendCommand,
    });
    await computer.prepare(createTestContext());

    expect(await computer.screenSize()).toEqual([1280, 720]);
    // projectId and location are private and only reach the Vertex AI client
    // constructor, so the service account is the option this asserts on.
    await computer.currentState();
    expect(accessTokenProvider).toHaveBeenCalledWith({
      sandboxName: SANDBOX_NAME,
      serviceAccountEmail: SERVICE_ACCOUNT,
      timeoutSeconds: 3600,
    });
  });

  it('test_init_with_byos', () => {
    const {computer} = createComputer({sandboxName: SANDBOX_NAME});

    expect(computer.agentEngineName).toBe(AGENT_ENGINE_NAME);
    expect(computer.sandboxName).toBe(SANDBOX_NAME);
  });

  it('test_init_with_template_derives_agent_engine', () => {
    const {computer} = createComputer({sandboxTemplateName: TEMPLATE_NAME});

    expect(computer.agentEngineName).toBe(AGENT_ENGINE_NAME);
    expect(computer.sandboxTemplateName).toBe(TEMPLATE_NAME);
  });

  it('test_init_with_snapshot_derives_agent_engine', () => {
    const {computer} = createComputer({sandboxSnapshotName: SNAPSHOT_NAME});

    expect(computer.agentEngineName).toBe(AGENT_ENGINE_NAME);
    expect(computer.sandboxSnapshotName).toBe(SNAPSHOT_NAME);
  });

  it('test_init_sandbox_name_takes_precedence_over_template', () => {
    const sandboxEngine =
      'projects/test/locations/us-central1/reasoningEngines/sandbox';
    const templateEngine =
      'projects/test/locations/us-central1/reasoningEngines/template';
    const {computer} = createComputer({
      sandboxName: `${sandboxEngine}/sandboxEnvironments/456`,
      sandboxTemplateName: `${templateEngine}/sandboxEnvironmentTemplates/789`,
    });

    expect(computer.agentEngineName).toBe(sandboxEngine);
  });

  it('test_init_without_sandbox_source_has_no_agent_engine', () => {
    const {computer} = createComputer();

    expect(computer.agentEngineName).toBeUndefined();
  });

  it('test_ensure_agent_engine_with_template_name', async () => {
    const {computer, vertexApi, context} = await createPreparedComputer({
      sandboxTemplateName: TEMPLATE_NAME,
    });

    await computer.currentState();

    expect(
      vertexApi.agentEnginesInternal.sandboxes.createInternal,
    ).toHaveBeenCalledWith(expect.objectContaining({name: AGENT_ENGINE_NAME}));
    // The engine came from the template, so nothing was created or shared.
    expect(
      vertexApi.agentEnginesInternal.createInternal,
    ).not.toHaveBeenCalled();
    expect(context.state.has(STATE_KEY_AGENT_ENGINE_NAME)).toBe(false);
  });

  it('test_init_with_vertexai_client', async () => {
    const {computer, vertexApi} = await createPreparedComputer({
      sandboxName: SANDBOX_NAME,
    });

    await computer.currentState();

    expect(
      vertexApi.agentEnginesInternal.sandboxes.getInternal,
    ).toHaveBeenCalledWith({name: SANDBOX_NAME});
  });

  it('test_screen_size', async () => {
    const {computer} = createComputer();

    expect(await computer.screenSize()).toEqual([1280, 720]);
  });

  it('test_environment', async () => {
    const {computer} = createComputer();

    expect(await computer.environment()).toBe(
      ComputerEnvironment.ENVIRONMENT_BROWSER,
    );
  });

  it('test_ensure_agent_engine_with_sandbox_name', async () => {
    const {computer, vertexApi, context} = await createPreparedComputer({
      sandboxName: SANDBOX_NAME,
    });

    await computer.currentState();

    expect(
      vertexApi.agentEnginesInternal.createInternal,
    ).not.toHaveBeenCalled();
    expect(context.state.has(STATE_KEY_AGENT_ENGINE_NAME)).toBe(false);
  });

  it('test_ensure_agent_engine_from_session_state', async () => {
    const sharedEngine =
      'projects/test/locations/us-central1/reasoningEngines/shared';
    const {computer, vertexApi, context} = await createPreparedComputer();
    context.state.set(STATE_KEY_AGENT_ENGINE_NAME, sharedEngine);

    await computer.currentState();

    expect(
      vertexApi.agentEnginesInternal.createInternal,
    ).not.toHaveBeenCalled();
    expect(
      vertexApi.agentEnginesInternal.sandboxes.createInternal,
    ).toHaveBeenCalledWith(expect.objectContaining({name: sharedEngine}));
  });

  it('test_ensure_agent_engine_creates_new', async () => {
    const {computer, vertexApi, context} = await createPreparedComputer();

    await computer.currentState();

    expect(vertexApi.agentEnginesInternal.createInternal).toHaveBeenCalled();
    expect(context.state.get(STATE_KEY_AGENT_ENGINE_NAME)).toBe(
      AGENT_ENGINE_NAME,
    );
  });

  it('test_get_sandbox_with_constructor_value', async () => {
    const {computer, vertexApi, context} = await createPreparedComputer({
      sandboxName: SANDBOX_NAME,
    });

    await computer.currentState();

    expect(
      vertexApi.agentEnginesInternal.sandboxes.getInternal,
    ).toHaveBeenCalledWith({name: SANDBOX_NAME});
    expect(
      vertexApi.agentEnginesInternal.sandboxes.createInternal,
    ).not.toHaveBeenCalled();
    // A sandbox the caller owns is never written back to the shared state.
    expect(context.state.has(STATE_KEY_SANDBOX_NAME)).toBe(false);
  });

  it('test_get_sandbox_from_session_state', async () => {
    const sharedSandbox = `${AGENT_ENGINE_NAME}/sandboxEnvironments/shared`;
    const {computer, vertexApi, context} = await createPreparedComputer();
    context.state.set(STATE_KEY_SANDBOX_NAME, sharedSandbox);

    await computer.currentState();

    expect(
      vertexApi.agentEnginesInternal.sandboxes.getInternal,
    ).toHaveBeenCalledWith({name: sharedSandbox});
    expect(
      vertexApi.agentEnginesInternal.sandboxes.createInternal,
    ).not.toHaveBeenCalled();
  });

  it('test_get_access_token_cached', async () => {
    const {computer, sandbox, accessTokenProvider, context} =
      await createPreparedComputer({sandboxName: SANDBOX_NAME});
    context.state.set(STATE_KEY_ACCESS_TOKEN, 'cached-token');
    context.state.set(STATE_KEY_TOKEN_EXPIRY, Date.now() / 1000 + 3600);

    await computer.currentState();

    expect(accessTokenProvider).not.toHaveBeenCalled();
    expect(sandbox.calls[0].accessToken).toBe('cached-token');
  });

  it('test_get_access_token_generates_new_when_expired', async () => {
    const {computer, sandbox, accessTokenProvider, context} =
      await createPreparedComputer({sandboxName: SANDBOX_NAME});
    context.state.set(STATE_KEY_ACCESS_TOKEN, 'expired-token');
    context.state.set(STATE_KEY_TOKEN_EXPIRY, Date.now() / 1000 - 100);

    await computer.currentState();

    expect(accessTokenProvider).toHaveBeenCalledTimes(1);
    expect(context.state.get(STATE_KEY_ACCESS_TOKEN)).toBe(ACCESS_TOKEN);
    expect(sandbox.calls[0].accessToken).toBe(ACCESS_TOKEN);
  });

  it('test_click_at', async () => {
    const {computer, sandbox} = await createPreparedComputer();

    const state = await computer.clickAt({x: 100, y: 200});

    expect(sandbox.batchedCommands().map((command) => command.params)).toEqual([
      {type: 'mousePressed', button: 'left', x: 100, y: 200, clickCount: 1},
      {type: 'mouseReleased', button: 'left', x: 100, y: 200, clickCount: 1},
    ]);
    expect(state.screenshot).toEqual(SCREENSHOT_BYTES);
    expect(state.url).toBe(PAGE_URL);
  });

  it('test_hover_at', async () => {
    const {computer, sandbox} = await createPreparedComputer();

    const state = await computer.hoverAt({x: 150, y: 250});

    expect(sandbox.bodiesTo('cdp')[0]).toEqual({
      command: 'Input.dispatchMouseEvent',
      params: {type: 'mouseMoved', x: 150, y: 250},
    });
    expect(state.screenshot).toEqual(SCREENSHOT_BYTES);
  });

  it('test_type_text_at', async () => {
    const {computer, sandbox} = await createPreparedComputer();

    const state = await computer.typeTextAt({
      x: 100,
      y: 200,
      text: 'hello',
      pressEnter: true,
      clearBeforeTyping: false,
    });

    const [click, typing] = sandbox
      .bodiesTo('cdps')
      .map((body) => body?.['commands']);
    expect(click).toHaveLength(2);
    // No clearing commands: the caller asked for clearBeforeTyping false.
    expect(typing).toEqual([
      {command: 'Input.insertText', params: {text: 'hello'}},
      {
        command: 'Input.dispatchKeyEvent',
        params: {type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter'},
      },
      {
        command: 'Input.dispatchKeyEvent',
        params: {type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter'},
      },
    ]);
    expect(state.screenshot).toEqual(SCREENSHOT_BYTES);
  });

  it('test_scroll_document', async () => {
    const {computer, sandbox} = await createPreparedComputer();

    const state = await computer.scrollDocument({direction: 'down'});

    // The centre of the 1280x720 screen, by the default magnitude.
    expect(sandbox.bodiesTo('cdp')[0]).toEqual({
      command: 'Input.dispatchMouseEvent',
      params: {type: 'mouseWheel', x: 640, y: 360, deltaX: 0, deltaY: 400},
    });
    expect(state.screenshot).toEqual(SCREENSHOT_BYTES);
  });

  it('test_scroll_at', async () => {
    const {computer, sandbox} = await createPreparedComputer();

    const state = await computer.scrollAt({
      x: 100,
      y: 200,
      direction: 'up',
      magnitude: 500,
    });

    expect(sandbox.bodiesTo('cdp')[0]).toEqual({
      command: 'Input.dispatchMouseEvent',
      params: {type: 'mouseWheel', x: 100, y: 200, deltaX: 0, deltaY: -500},
    });
    expect(state.screenshot).toEqual(SCREENSHOT_BYTES);
  });

  it('test_navigate', async () => {
    const {computer, sandbox} = await createPreparedComputer();

    const state = await computer.navigate({url: 'https://newsite.com'});

    expect(sandbox.bodiesTo('cdp')[0]).toEqual({
      command: 'Page.navigate',
      params: {url: 'https://newsite.com'},
    });
    expect(state.url).toBe(PAGE_URL);
  });

  it('test_search', async () => {
    const {computer, sandbox} = await createPreparedComputer({
      searchEngineUrl: 'https://www.google.com',
    });

    const state = await computer.search();

    expect(sandbox.bodiesTo('cdp')[0]).toEqual({
      command: 'Page.navigate',
      params: {url: 'https://www.google.com'},
    });
    expect(state.screenshot).toEqual(SCREENSHOT_BYTES);
  });

  it('test_go_back', async () => {
    const {computer, sandbox} = await createPreparedComputer({
      history: {currentIndex: 1, entries: [{id: 11}, {id: 12}]},
    });

    const state = await computer.goBack();

    expect(sandbox.bodiesTo('cdp')[1]).toEqual({
      command: 'Page.navigateToHistoryEntry',
      params: {entryId: 11},
    });
    expect(state.screenshot).toEqual(SCREENSHOT_BYTES);
  });

  it('test_go_forward', async () => {
    const {computer, sandbox} = await createPreparedComputer({
      history: {currentIndex: 0, entries: [{id: 11}, {id: 12}]},
    });

    const state = await computer.goForward();

    expect(sandbox.bodiesTo('cdp')[1]).toEqual({
      command: 'Page.navigateToHistoryEntry',
      params: {entryId: 12},
    });
    expect(state.screenshot).toEqual(SCREENSHOT_BYTES);
  });

  it('test_key_combination', async () => {
    const {computer, sandbox} = await createPreparedComputer();

    const state = await computer.keyCombination({keys: ['control', 'c']});

    expect(sandbox.batchedCommands().map((command) => command.params)).toEqual([
      {type: 'keyDown', key: 'Control_L'},
      {type: 'keyDown', text: 'c'},
      {type: 'keyUp', text: 'c'},
      {type: 'keyUp', key: 'Control_L'},
    ]);
    expect(state.screenshot).toEqual(SCREENSHOT_BYTES);
  });

  it('test_drag_and_drop', async () => {
    const {computer, sandbox} = await createPreparedComputer();

    const state = await computer.dragAndDrop({
      x: 10,
      y: 20,
      destinationX: 100,
      destinationY: 200,
    });

    expect(sandbox.batchedCommands().map((command) => command.params)).toEqual([
      {type: 'mouseMoved', x: 10, y: 20},
      {type: 'mousePressed', button: 'left', x: 10, y: 20, clickCount: 1},
      {type: 'mouseMoved', x: 100, y: 200},
      {
        type: 'mouseReleased',
        button: 'left',
        x: 100,
        y: 200,
        clickCount: 1,
      },
    ]);
    expect(state.screenshot).toEqual(SCREENSHOT_BYTES);
  });

  it('test_wait', async () => {
    const {computer} = await createPreparedComputer();
    vi.useFakeTimers();

    const waiting = computer.wait({seconds: 1});
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const state = await waiting;

    expect(state.screenshot).toEqual(SCREENSHOT_BYTES);
  });

  it('test_current_state', async () => {
    const {computer} = await createPreparedComputer();

    const state = await computer.currentState();

    expect(state.screenshot).toEqual(SCREENSHOT_BYTES);
    expect(state.url).toBe(PAGE_URL);
  });

  it('test_open_web_browser', async () => {
    const {computer} = await createPreparedComputer();

    const state = await computer.openWebBrowser();

    expect(state.screenshot).toEqual(SCREENSHOT_BYTES);
    expect(state.url).toBe(PAGE_URL);
  });

  it('test_initialize_is_noop', async () => {
    const {computer, vertexApi} = createComputer();

    await expect(computer.initialize()).resolves.toBeUndefined();
    expect(
      vertexApi.agentEnginesInternal.sandboxes.createInternal,
    ).not.toHaveBeenCalled();
  });

  it('test_close_is_noop', async () => {
    const {computer, vertexApi} = createComputer();

    await expect(computer.close()).resolves.toBeUndefined();
    expect(
      vertexApi.agentEnginesInternal.sandboxes.getInternal,
    ).not.toHaveBeenCalled();
  });
});
