/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseComputer,
  BaseLlm,
  BaseLlmConnection,
  ComputerEnvironment,
  ComputerState,
  ComputerUseToolset,
  Event,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  URL_REFUSED_ERROR,
} from '@google/adk';
import {createUserContent, Environment} from '@google/genai';
import {describe, expect, it} from 'vitest';

/** The screen the fake browser reports, non-square so a swapped axis shows. */
const SCREEN: [number, number] = [1920, 1080];

/** An in-memory browser: it records the actions and tracks the current page. */
class InMemoryBrowser extends BaseComputer {
  readonly actions: Array<{name: string; args?: Record<string, unknown>}> = [];
  url = 'https://start.example.com/';
  closed = false;

  override async close(): Promise<void> {
    this.closed = true;
  }

  async screenSize(): Promise<[number, number]> {
    return SCREEN;
  }

  async environment(): Promise<ComputerEnvironment> {
    return ComputerEnvironment.ENVIRONMENT_BROWSER;
  }

  async openWebBrowser(): Promise<ComputerState> {
    return this.act('openWebBrowser');
  }
  async clickAt(args: {x: number; y: number}): Promise<ComputerState> {
    return this.act('clickAt', args);
  }
  async hoverAt(args: {x: number; y: number}): Promise<ComputerState> {
    return this.act('hoverAt', args);
  }
  async typeTextAt(args: {
    x: number;
    y: number;
    text: string;
  }): Promise<ComputerState> {
    return this.act('typeTextAt', args);
  }
  async scrollDocument(args: {direction: string}): Promise<ComputerState> {
    return this.act('scrollDocument', args);
  }
  async scrollAt(args: {
    x: number;
    y: number;
    direction: string;
    magnitude: number;
  }): Promise<ComputerState> {
    return this.act('scrollAt', args);
  }
  async wait(args: {seconds: number}): Promise<ComputerState> {
    return this.act('wait', args);
  }
  async goBack(): Promise<ComputerState> {
    return this.act('goBack');
  }
  async goForward(): Promise<ComputerState> {
    return this.act('goForward');
  }
  async search(): Promise<ComputerState> {
    return this.act('search');
  }
  async navigate(args: {url: string}): Promise<ComputerState> {
    this.url = args.url;
    return this.act('navigate', args);
  }
  async keyCombination(args: {keys: string[]}): Promise<ComputerState> {
    return this.act('keyCombination', args);
  }
  async dragAndDrop(args: {
    x: number;
    y: number;
    destinationX: number;
    destinationY: number;
  }): Promise<ComputerState> {
    return this.act('dragAndDrop', args);
  }
  async currentState(): Promise<ComputerState> {
    return this.act('currentState');
  }

  /** The names of the actions performed so far, in order. */
  names(): string[] {
    return this.actions.map((action) => action.name);
  }

  private act(name: string, args?: Record<string, unknown>): ComputerState {
    this.actions.push({name, args});
    return {screenshot: new Uint8Array([137, 80, 78, 71]), url: this.url};
  }
}

/**
 * A model that calls one computer-use function, then answers in text once it
 * has the function response.
 */
class ScriptedComputerUseLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor(
    private readonly call: {name: string; args: Record<string, unknown>},
  ) {
    super({model: 'gemini-2.5-computer-use-preview-10-2025'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(request);
    const answered = (request.contents ?? []).some((content) =>
      (content.parts ?? []).some((part) => part.functionResponse),
    );
    yield answered
      ? {content: {role: 'model', parts: [{text: 'Done.'}]}}
      : {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-1',
                  name: this.call.name,
                  args: this.call.args,
                },
              },
            ],
          },
        };
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('the live path is not exercised by this test');
  }
}

/** Runs one turn of a computer-use agent and returns what everyone recorded. */
async function runTurn(call: {name: string; args: Record<string, unknown>}) {
  const computer = new InMemoryBrowser();
  const toolset = new ComputerUseToolset({computer});
  const model = new ScriptedComputerUseLlm(call);
  const agent = new LlmAgent({
    name: 'browser_agent',
    model,
    tools: [toolset],
  });
  const runner = new InMemoryRunner({agent, appName: 'computer_use_app'});
  const session = await runner.sessionService.createSession({
    appName: 'computer_use_app',
    userId: 'test_user',
  });

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'test_user',
    sessionId: session.id,
    newMessage: createUserContent('drive the browser'),
  })) {
    events.push(event);
  }

  const responses = events
    .flatMap((event) => event.content?.parts ?? [])
    .filter((part) => part.functionResponse)
    .map((part) => part.functionResponse!.response);

  return {computer, model, events, responses};
}

describe('an agent driving a computer', () => {
  it('asks the API for the computer-use declarations and dispatches the call', async () => {
    const {computer, model, responses} = await runTurn({
      name: 'click_at',
      args: {x: 500, y: 500},
    });

    expect(model.requests[0].config?.tools).toContainEqual({
      computerUse: {
        environment: Environment.ENVIRONMENT_BROWSER,
        excludedPredefinedFunctions: undefined,
      },
    });
    expect(Object.keys(model.requests[0].toolsDict)).toContain('click_at');
    // 500 of a virtual 1000 maps onto a 1920x1080 screen.
    expect(computer.actions).toEqual([
      {name: 'clickAt', args: {x: 960, y: 540}},
    ]);
    expect(responses[0]).toEqual({
      image: {mimetype: 'image/png', data: 'iVBORw=='},
      url: 'https://start.example.com/',
    });
  });

  it('refuses a navigate to the metadata endpoint and never drives the browser', async () => {
    const {computer, responses} = await runTurn({
      name: 'navigate',
      args: {url: 'http://169.254.169.254/'},
    });

    expect(responses[0]).toEqual({
      error: URL_REFUSED_ERROR,
      url: 'https://start.example.com/',
    });
    expect(computer.names()).toEqual(['currentState']);
    expect(computer.url).toBe('https://start.example.com/');
  });

  it('closes the driver when the run finishes', async () => {
    const {computer} = await runTurn({name: 'go_back', args: {}});

    expect(computer.closed).toBe(true);
  });
});
