/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmRequest} from '@google/adk';
import {
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentResponse,
  HttpOptions,
  Schema,
  Type,
} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  buildFunctionDeclarationLog,
  buildRequestLog,
  buildResponseLog,
} from '../../src/models/llm_log_utils.js';

function createRequest(
  config: GenerateContentConfig,
  contents: LlmRequest['contents'] = [],
): LlmRequest {
  return {
    model: 'gemini-2.5-flash',
    contents,
    config,
    liveConnectConfig: {},
    toolsDict: {},
  };
}

/** Returns the block between two `-----` separators, by section heading. */
function section(log: string, heading: string): string {
  const blocks = log.split(/^-{59}$/m);
  const block = blocks.find((candidate) =>
    candidate.trimStart().startsWith(`${heading}:`),
  );
  expect(block, `no "${heading}" section in log`).toBeDefined();
  return block!;
}

describe('buildFunctionDeclarationLog', () => {
  it('renders declared parameters and the declared response', () => {
    const declaration: FunctionDeclaration = {
      name: 'set_light',
      parameters: {
        type: Type.OBJECT,
        properties: {brightness: {type: Type.NUMBER}},
      },
      response: {type: Type.STRING},
    };

    expect(buildFunctionDeclarationLog(declaration)).toBe(
      'set_light: {"brightness":{"type":"NUMBER"}} -> {"type":"STRING"}',
    );
  });

  it('falls back to the JSON schema fields', () => {
    const declaration: FunctionDeclaration = {
      name: 'lookup',
      parametersJsonSchema: {type: 'object'},
      responseJsonSchema: {type: 'string'},
    };

    expect(buildFunctionDeclarationLog(declaration)).toBe(
      'lookup: {"type":"object"} -> {"type":"string"}',
    );
  });

  it('renders empty parameters and no response arrow', () => {
    expect(buildFunctionDeclarationLog({name: 'ping'})).toBe('ping: {}');
  });

  it('renders empty parameters when properties are absent', () => {
    const declaration: FunctionDeclaration = {
      name: 'ping',
      parameters: {type: Type.OBJECT},
    };

    expect(buildFunctionDeclarationLog(declaration)).toBe('ping: {}');
  });
});

describe('buildRequestLog', () => {
  it('keeps other tools in the config and moves declarations to their own section', () => {
    const request = createRequest({
      tools: [
        {functionDeclarations: [{name: 'set_light'}]},
        {codeExecution: {}},
      ],
    });

    const log = buildRequestLog(request);
    const configSection = section(log, 'Config');

    expect(configSection).toContain('codeExecution');
    expect(configSection).not.toContain('functionDeclarations');
    expect(section(log, 'Functions')).toContain('set_light: {}');
  });

  it('finds declarations carried by a later tool', () => {
    const request = createRequest({
      tools: [{codeExecution: {}}, {functionDeclarations: [{name: 'lookup'}]}],
    });

    const log = buildRequestLog(request);

    expect(section(log, 'Config')).toContain('codeExecution');
    expect(section(log, 'Config')).not.toContain('lookup');
    expect(section(log, 'Functions')).toContain('lookup: {}');
  });

  it('drops the tools entirely when none declares a function', () => {
    const request = createRequest({
      temperature: 0.5,
      tools: [{codeExecution: {}}],
    });

    // simplicity: a tool with an empty declaration list is "no declarations",
    // matching adk-python's truthiness check.
    const emptyDeclarations = createRequest({
      tools: [{functionDeclarations: []}],
    });

    expect(section(buildRequestLog(request), 'Config')).not.toContain('tools');
    expect(section(buildRequestLog(request), 'Config')).toContain(
      'temperature',
    );
    expect(section(buildRequestLog(emptyDeclarations), 'Config')).not.toContain(
      'tools',
    );
  });

  it('reports a config it cannot serialize without dumping it', () => {
    const schema: Schema = {type: Type.OBJECT};
    schema.items = schema;
    const request = createRequest({responseSchema: schema});

    const log = buildRequestLog(request);

    expect(section(log, 'Config')).toContain('<error building config log>');
  });

  it('omits every http option, including fields the SDK may add later', () => {
    const httpOptions: HttpOptions = {
      headers: {Authorization: 'Bearer secret-token-sentinel'},
      baseUrl: 'https://proxy.example.com/?signature=signature-sentinel',
      apiVersion: 'v1alpha',
      timeout: 1000,
    };
    const request = createRequest({temperature: 0.5, httpOptions});

    const log = buildRequestLog(request);
    const configSection = section(log, 'Config');

    expect(configSection).toContain('temperature');
    expect(configSection).not.toContain('secret-token-sentinel');
    expect(configSection).not.toContain('signature-sentinel');
    for (const key of Object.keys(httpOptions)) {
      expect(configSection, `http option "${key}" leaked`).not.toContain(key);
    }
  });

  it('logs the inline data type but not its bytes', () => {
    const request = createRequest({}, [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              displayName: 'shot.png',
              data: 'ZmFrZS1ieXRlcy1zZW50aW5lbA==',
            },
          },
          {text: 'describe this'},
        ],
      },
    ]);

    const contentsSection = section(buildRequestLog(request), 'Contents');

    expect(contentsSection).toContain('image/png');
    expect(contentsSection).toContain('shot.png');
    expect(contentsSection).toContain('describe this');
    expect(contentsSection).not.toContain('ZmFrZS1ieXRlcy1zZW50aW5lbA==');
  });

  it('logs the system instruction in its own section', () => {
    const request = createRequest({systemInstruction: 'be brief'});

    const log = buildRequestLog(request);

    expect(section(log, 'System Instruction')).toContain('be brief');
    expect(section(log, 'Config')).not.toContain('be brief');
  });

  it('renders a request with no config at all', () => {
    const request: LlmRequest = {
      model: 'gemini-2.5-flash',
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };

    const log = buildRequestLog(request);

    expect(log).toContain('LLM Request:');
    expect(section(log, 'Config').trim()).toBe('Config:\n{}');
  });

  it('drops a null the model or the caller left in the schema', () => {
    const request = createRequest({
      tools: [
        {
          functionDeclarations: [
            {
              name: 'lookup',
              parametersJsonSchema: {type: 'object', description: null},
            },
          ],
        },
      ],
    });

    const functionsSection = section(buildRequestLog(request), 'Functions');

    expect(functionsSection).toContain('lookup: {"type":"object"}');
  });
});

describe('buildResponseLog', () => {
  it('joins the first candidate text, skips reasoning and lists calls', () => {
    const response = new GenerateContentResponse();
    response.candidates = [
      {
        content: {
          role: 'model',
          parts: [
            {text: 'Hello '},
            {text: 'internal reasoning', thought: true},
            {text: 'world'},
            {functionCall: {name: 'set_light', args: {brightness: 10}}},
          ],
        },
      },
      {content: {role: 'model', parts: [{text: 'second candidate'}]}},
    ];

    const log = buildResponseLog(response);

    expect(section(log, 'Text')).toContain('Hello world');
    expect(section(log, 'Text')).not.toContain('internal reasoning');
    expect(section(log, 'Text')).not.toContain('second candidate');
    expect(section(log, 'Function calls')).toContain(
      'name: set_light, args: {"brightness":10}',
    );
    expect(section(log, 'Raw response')).toContain('internal reasoning');
  });

  it('renders empty sections for a response with no candidates', () => {
    const log = buildResponseLog(new GenerateContentResponse());

    expect(log).toContain('LLM Response:');
    expect(section(log, 'Text').trim()).toBe('Text:');
    expect(section(log, 'Function calls').trim()).toBe('Function calls:');
  });
});
