/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ToolConnectionAnalyzer} from '@google/adk';
import {FunctionDeclaration} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {logger} from '../../../src/utils/logger.js';

import {
  StubTool,
  promptOf,
  stubRegistry,
  stubRegistryWithText,
  textResponses,
} from './environment_simulation_test_utils.js';

const CREATE_TICKET_DECLARATION: FunctionDeclaration = {
  name: 'create_ticket',
  description: 'Creates a ticket.',
};
const CREATE_TICKET = new StubTool('create_ticket', CREATE_TICKET_DECLARATION);
const GET_TICKET = new StubTool('get_ticket', {
  name: 'get_ticket',
  description: 'Reads a ticket.',
});
const DECLARATIONLESS_TOOL = new StubTool('builtin_search');

const CONNECTION_MAP_JSON = JSON.stringify({
  stateful_parameters: [
    {
      parameter_name: 'ticket_id',
      creating_tools: ['create_ticket'],
      consuming_tools: ['get_ticket'],
    },
  ],
});

describe('ToolConnectionAnalyzer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses a snake_case response into a camelCase connection map', async () => {
    stubRegistryWithText([CONNECTION_MAP_JSON]);
    const analyzer = new ToolConnectionAnalyzer('test-model', {});

    const map = await analyzer.analyze([CREATE_TICKET, GET_TICKET]);

    expect(map).toEqual({
      statefulParameters: [
        {
          parameterName: 'ticket_id',
          creatingTools: ['create_ticket'],
          consumingTools: ['get_ticket'],
        },
      ],
    });
  });

  it('parses a response wrapped in a json code fence', async () => {
    stubRegistryWithText([`\`\`\`json\n${CONNECTION_MAP_JSON}\n\`\`\``]);
    const analyzer = new ToolConnectionAnalyzer('test-model', {});

    const map = await analyzer.analyze([CREATE_TICKET]);

    expect(map.statefulParameters[0].parameterName).toBe('ticket_id');
  });

  it('parses a response wrapped in an unlabelled code fence', async () => {
    stubRegistryWithText([`\`\`\`\n${CONNECTION_MAP_JSON}\n\`\`\``]);
    const analyzer = new ToolConnectionAnalyzer('test-model', {});

    const map = await analyzer.analyze([CREATE_TICKET]);

    expect(map.statefulParameters[0].parameterName).toBe('ticket_id');
  });

  it('concatenates a multi-chunk streamed response before parsing', async () => {
    const half = Math.floor(CONNECTION_MAP_JSON.length / 2);
    stubRegistryWithText([
      CONNECTION_MAP_JSON.slice(0, half),
      CONNECTION_MAP_JSON.slice(half),
    ]);
    const analyzer = new ToolConnectionAnalyzer('test-model', {});

    const map = await analyzer.analyze([CREATE_TICKET]);

    expect(map.statefulParameters[0].consumingTools).toEqual(['get_ticket']);
  });

  it('skips streamed responses that carry no text', async () => {
    stubRegistry([
      {},
      {content: {role: 'model'}},
      {content: {role: 'model', parts: [{thought: true}]}},
      ...textResponses([CONNECTION_MAP_JSON]),
    ]);
    const analyzer = new ToolConnectionAnalyzer('test-model', {});

    const map = await analyzer.analyze([CREATE_TICKET]);

    expect(map.statefulParameters[0].parameterName).toBe('ticket_id');
  });

  it('warns and returns an empty map for a non-JSON response', async () => {
    stubRegistryWithText(['I am afraid I cannot do that.']);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const analyzer = new ToolConnectionAnalyzer('test-model', {});

    const map = await analyzer.analyze([CREATE_TICKET]);

    expect(map).toEqual({statefulParameters: []});
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0];
    expect(message).toContain('Failed to parse tool connection analysis');
    expect(message).toContain('I am afraid I cannot do that.');
  });

  it('excludes tools without a declaration from the prompt', async () => {
    const llm = stubRegistryWithText([CONNECTION_MAP_JSON]);
    const analyzer = new ToolConnectionAnalyzer('test-model', {});

    await analyzer.analyze([CREATE_TICKET, DECLARATIONLESS_TOOL]);

    expect(promptOf(llm)).toContain(
      JSON.stringify([CREATE_TICKET_DECLARATION], null, 2),
    );
  });

  it('sends the configured model, generation config and JSON mime type', async () => {
    const llm = stubRegistryWithText([CONNECTION_MAP_JSON]);
    const analyzer = new ToolConnectionAnalyzer('test-model', {
      temperature: 0.25,
    });

    await analyzer.analyze([CREATE_TICKET]);

    const [request] = llm.requests;
    expect(request.model).toBe('test-model');
    expect(request.config).toEqual({
      temperature: 0.25,
      responseMimeType: 'application/json',
    });
    expect(request.contents[0].role).toBe('user');
  });

  it('asks for single-brace delimited JSON in the prompt', async () => {
    const llm = stubRegistryWithText([CONNECTION_MAP_JSON]);
    const analyzer = new ToolConnectionAnalyzer('test-model', {});

    await analyzer.analyze([CREATE_TICKET]);

    expect(promptOf(llm)).toContain(
      "Your response must start with '{' and end with '}'.",
    );
  });

  it('rejects a well-formed JSON response that is not a connection map', async () => {
    stubRegistryWithText([JSON.stringify({unexpected: true})]);
    const analyzer = new ToolConnectionAnalyzer('test-model', {});

    await expect(analyzer.analyze([CREATE_TICKET])).rejects.toThrow();
  });
});
