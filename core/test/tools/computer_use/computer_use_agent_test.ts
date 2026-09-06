/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  ComputerUseToolset,
  Event,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {Environment, FunctionResponse} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {MOCK_PAGE_URL, MockComputer} from './computer_use_test_utils.js';

/** Asks for one `click_at`, then answers once the response comes back. */
class ClickingLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor() {
    super({model: 'gemini-2.5-flash'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(request);
    const answered = (request.contents ?? []).some((content) =>
      (content.parts ?? []).some((part) => part.functionResponse),
    );
    yield answered
      ? {content: {role: 'model', parts: [{text: 'Clicked.'}]}}
      : {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-1',
                  name: 'click_at',
                  args: {x: 500, y: 500},
                },
              },
            ],
          },
        };
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('not used in this test');
  }
}

/** Runs one turn of an agent built over `computer` and returns what happened. */
async function runOneTurn(computer: MockComputer): Promise<{
  model: ClickingLlm;
  responses: FunctionResponse[];
  events: Event[];
}> {
  const model = new ClickingLlm();
  const agent = new LlmAgent({
    name: 'browser_agent',
    model,
    tools: [new ComputerUseToolset({computer})],
  });
  const runner = new InMemoryRunner({agent, appName: 'computer_use_app'});
  const session = await runner.sessionService.createSession({
    appName: 'computer_use_app',
    userId: 'u1',
  });

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: 'u1',
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'click the button'}]},
  })) {
    events.push(event);
  }

  const responses = events
    .flatMap((event) => event.content?.parts ?? [])
    .filter((part) => part.functionResponse)
    .map((part) => part.functionResponse!);
  return {model, responses, events};
}

// An LlmAgent expands a toolset into its tools and calls processLlmRequest on
// each one; it never calls BaseToolset.processLlmRequest. Registering from the
// toolset alone left the model with no computer-use configuration and every
// call unresolvable.
describe('ComputerUseToolset driven by an LlmAgent', () => {
  it('puts the model into computer-use mode', async () => {
    const {model} = await runOneTurn(new MockComputer());

    const configured = (model.requests[0].config?.tools ?? []).filter(
      (tool) => 'computerUse' in tool && tool.computerUse,
    );
    expect(configured).toHaveLength(1);
    expect(configured[0]).toEqual({
      computerUse: {
        environment: Environment.ENVIRONMENT_BROWSER,
        excludedPredefinedFunctions: undefined,
      },
    });
  });

  it('registers every action so a call naming one can resolve', async () => {
    const {model} = await runOneTurn(new MockComputer());

    expect(Object.keys(model.requests[0].toolsDict)).toContain('click_at');
    expect(Object.keys(model.requests[0].toolsDict)).toHaveLength(14);
  });

  it('declares no computer-use function, because the model knows them', async () => {
    const {model} = await runOneTurn(new MockComputer());

    const declared = (model.requests[0].config?.tools ?? []).flatMap((tool) =>
      'functionDeclarations' in tool ? (tool.functionDeclarations ?? []) : [],
    );
    expect(declared).toEqual([]);
  });

  it('routes the model call to the driver and answers with the new page', async () => {
    const {responses, events} = await runOneTurn(new MockComputer());

    expect(events.filter((event) => event.errorMessage)).toEqual([]);
    expect(responses).toHaveLength(1);
    expect(responses[0].name).toBe('click_at');
    expect(responses[0].response).toEqual({
      image: {mimetype: 'image/png', data: 'dGVzdA=='},
      url: `${MOCK_PAGE_URL}/click/960/540`,
    });
  });

  // The predefined names are generic, so a user tool can already hold one.
  // Taking it over silently would remove a tool the user asked for.
  it('reports a user tool that collides with a predefined name', async () => {
    const agent = new LlmAgent({
      name: 'browser_agent',
      model: new ClickingLlm(),
      tools: [
        new FunctionTool({
          name: 'search',
          description: "The user's own search tool.",
          execute: async () => 'mine',
        }),
        new ComputerUseToolset({computer: new MockComputer()}),
      ],
    });
    const runner = new InMemoryRunner({agent, appName: 'collision_app'});
    const session = await runner.sessionService.createSession({
      appName: 'collision_app',
      userId: 'u1',
    });

    const turn = async () => {
      for await (const event of runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'go'}]},
      })) {
        expect(event).toBeDefined();
      }
    };

    await expect(turn()).rejects.toThrow('Duplicate tool name: search');
  });

  it('configures computer use once, not once per turn', async () => {
    const {model} = await runOneTurn(new MockComputer());

    expect(model.requests).toHaveLength(2);
    for (const request of model.requests) {
      const configured = (request.config?.tools ?? []).filter(
        (tool) => 'computerUse' in tool && tool.computerUse,
      );
      expect(configured).toHaveLength(1);
    }
  });
});
