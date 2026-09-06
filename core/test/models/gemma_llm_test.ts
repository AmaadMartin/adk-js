/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Gemini,
  Gemma,
  GoogleLLMVariant,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {
  Content,
  GenerateContentResponse,
  Schema,
  Tool,
  Type,
} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
function preprocessGemmaRequest(
  gemma: Gemma,
  request: LlmRequest,
): Promise<void> {
  return (
    gemma as unknown as {
      preprocessGemmaRequest(r: LlmRequest): Promise<void>;
    }
  ).preprocessGemmaRequest(request);
}

describe('Gemma LLM', () => {
  let llmRequest: LlmRequest;

  beforeEach(() => {
    llmRequest = {
      model: 'gemma-3-4b-it',
      contents: [
        {
          role: 'user',
          parts: [{text: 'Hello'}],
        },
      ],
      config: {
        temperature: 0.1,
        systemInstruction: 'You are a helpful assistant',
      },
      toolsDict: {},
      liveConnectConfig: {},
    };
  });

  it('resolves model to Gemma class via the registry', () => {
    expect(LLMRegistry.resolve('gemma-4-31b-it')).toBe(Gemma);
    expect(LLMRegistry.resolve('gemma-3-27b-it')).toBe(Gemma);
    expect(LLMRegistry.resolve('gemma3@gemma-3-27b-it')).toBe(Gemma);
    expect(LLMRegistry.resolve('google/gemma3@gemma-3-27b-it')).toBe(Gemma);
  });

  it('should default model to gemma-3-27b-it', () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    expect(gemma.model).toBe('gemma-3-27b-it');
  });

  it('should return GEMINI_API for apiBackend', () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    expect(gemma.apiBackend).toBe(GoogleLLMVariant.GEMINI_API);
  });

  it('should throw error if model is not a Gemma model', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const badRequest: LlmRequest = {
      model: 'not-gemma-model',
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await expect(async () => {
      for await (const _ of gemma.generateContentAsync(badRequest)) {
        // empty
      }
    }).rejects.toThrow(/Requesting a non-Gemma model/);
  });

  it('should preprocess system instruction to user role message', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    await preprocessGemmaRequest(gemma, llmRequest);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.contents.length).toBe(2);
    expect(llmRequest.contents[0].role).toBe('user');
    expect(llmRequest.contents[0].parts?.[0].text).toBe(
      'You are a helpful assistant',
    );
    expect(llmRequest.contents[1].role).toBe('user');
    expect(llmRequest.contents[1].parts?.[0].text).toBe('Hello');
  });

  it('should handle empty contents when preprocessing system instruction', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    llmRequest.contents = [];

    await preprocessGemmaRequest(gemma, llmRequest);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
    expect(llmRequest.contents.length).toBe(1);
    expect(llmRequest.contents[0].role).toBe('user');
    expect(llmRequest.contents[0].parts?.[0].text).toBe(
      'You are a helpful assistant',
    );
  });

  it('should not duplicate system instruction if already prepended', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    llmRequest.contents = [
      {
        role: 'user',
        parts: [{text: 'You are a helpful assistant'}],
      },
      {
        role: 'user',
        parts: [{text: 'Hello'}],
      },
    ];

    await preprocessGemmaRequest(gemma, llmRequest);

    expect(llmRequest.contents.length).toBe(2);
    expect(llmRequest.contents[0].parts?.[0].text).toBe(
      'You are a helpful assistant',
    );
  });

  it('should preprocess tools and append to system instruction', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const testTool: Tool = {
      functionDeclarations: [
        {
          name: 'search_web',
          description: 'Search the web for a query.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              query: {type: Type.STRING},
            },
            required: ['query'],
          } as Schema,
        },
      ],
    };

    llmRequest.config = {
      tools: [testTool],
    };

    await preprocessGemmaRequest(gemma, llmRequest);

    expect(llmRequest.config?.tools).toEqual([]);
    expect(llmRequest.contents.length).toBe(2); // tools prepended + original hello
    const textContent = llmRequest.contents[0].parts?.[0].text;
    expect(textContent).toContain('You have access to the following functions');
    expect(textContent).toContain('search_web');
    expect(textContent).toContain('Search the web for a query.');
  });

  it('should convert function response parts to user text', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    llmRequest.contents = [
      {
        role: 'model',
        parts: [
          {
            functionResponse: {
              name: 'search_web',
              response: {results: [{title: 'ADK'}]},
            },
          },
        ],
      },
    ];
    // Clear systemInstruction so we only test function response conversion
    llmRequest.config = {};

    await preprocessGemmaRequest(gemma, llmRequest);

    expect(llmRequest.contents.length).toBe(1);
    expect(llmRequest.contents[0].role).toBe('user');
    expect(llmRequest.contents[0].parts?.[0].text).toBe(
      'Invoking tool `search_web` produced: `{"results":[{"title":"ADK"}]}`.',
    );
  });

  it('should convert function call parts to model text JSON', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    llmRequest.contents = [
      {
        role: 'user',
        parts: [
          {
            functionCall: {
              name: 'get_current_time',
              args: {},
            },
          },
        ],
      },
    ];
    // Clear systemInstruction so we only test function call conversion
    llmRequest.config = {};

    await preprocessGemmaRequest(gemma, llmRequest);

    expect(llmRequest.contents.length).toBe(1);
    expect(llmRequest.contents[0].role).toBe('model');
    expect(llmRequest.contents[0].parts?.[0].text).toBe(
      '{"name":"get_current_time","args":{}}',
    );
  });

  it('should extract function calls from response text JSON', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const mockResponse = new GenerateContentResponse();
    mockResponse.candidates = [
      {
        content: {
          role: 'model',
          parts: [
            {
              text: '{"name": "search_web", "parameters": {"query": "latest news"}}',
            },
          ],
        },
      },
    ];

    const superSpy = vi
      .spyOn(gemma['apiClient'].models, 'generateContent')
      .mockResolvedValue(mockResponse);

    const responses: LlmResponse[] = [];
    for await (const response of gemma.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses.length).toBe(1);
    const parts = responses[0].content?.parts;
    expect(parts?.length).toBe(1);
    expect(parts?.[0].functionCall).toBeDefined();
    expect(parts?.[0].functionCall?.name).toBe('search_web');
    expect(parts?.[0].functionCall?.args).toEqual({query: 'latest news'});

    superSpy.mockRestore();
  });

  it('should extract function calls from markdown code block', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const mockResponse = new GenerateContentResponse();
    mockResponse.candidates = [
      {
        content: {
          role: 'model',
          parts: [
            {
              text: '```json\n{"name": "search_web", "parameters": {"query": "latest news"}}\n```',
            },
          ],
        },
      },
    ];

    const superSpy = vi
      .spyOn(gemma['apiClient'].models, 'generateContent')
      .mockResolvedValue(mockResponse);

    const responses: LlmResponse[] = [];
    for await (const response of gemma.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses.length).toBe(1);
    const parts = responses[0].content?.parts;
    expect(parts?.length).toBe(1);
    expect(parts?.[0].functionCall).toBeDefined();
    expect(parts?.[0].functionCall?.name).toBe('search_web');
    expect(parts?.[0].functionCall?.args).toEqual({query: 'latest news'});

    superSpy.mockRestore();
  });

  it('should support flexible function call formats', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const mockResponse = new GenerateContentResponse();
    mockResponse.candidates = [
      {
        content: {
          role: 'model',
          parts: [
            {
              text: '{"function": "do_something", "args": {"value": 123}}',
            },
          ],
        },
      },
    ];

    const superSpy = vi
      .spyOn(gemma['apiClient'].models, 'generateContent')
      .mockResolvedValue(mockResponse);

    const responses: LlmResponse[] = [];
    for await (const response of gemma.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses.length).toBe(1);
    const parts = responses[0].content?.parts;
    expect(parts?.length).toBe(1);
    expect(parts?.[0].functionCall).toBeDefined();
    expect(parts?.[0].functionCall?.name).toBe('do_something');
    expect(parts?.[0].functionCall?.args).toEqual({value: 123});

    superSpy.mockRestore();
  });

  it('should ignore invalid json and leave response as text', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const mockResponse = new GenerateContentResponse();
    mockResponse.candidates = [
      {
        content: {
          role: 'model',
          parts: [
            {
              text: 'This is not JSON.',
            },
          ],
        },
      },
    ];

    const superSpy = vi
      .spyOn(gemma['apiClient'].models, 'generateContent')
      .mockResolvedValue(mockResponse);

    const responses: LlmResponse[] = [];
    for await (const response of gemma.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses.length).toBe(1);
    const parts = responses[0].content?.parts;
    expect(parts?.length).toBe(1);
    expect(parts?.[0].functionCall).toBeUndefined();
    expect(parts?.[0].text).toBe('This is not JSON.');

    superSpy.mockRestore();
  });

  it('should handle markdown block with malformed JSON', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const mockResponse = new GenerateContentResponse();
    mockResponse.candidates = [
      {
        content: {
          role: 'model',
          parts: [
            {
              text: '```json\n{ malformed: json }\n```',
            },
          ],
        },
      },
    ];

    const superSpy = vi
      .spyOn(gemma['apiClient'].models, 'generateContent')
      .mockResolvedValue(mockResponse);

    const responses: LlmResponse[] = [];
    for await (const response of gemma.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses.length).toBe(1);
    const parts = responses[0].content?.parts;
    expect(parts?.length).toBe(1);
    expect(parts?.[0].functionCall).toBeUndefined();
    expect(parts?.[0].text).toBe('```json\n{ malformed: json }\n```');

    superSpy.mockRestore();
  });

  it('should handle text with a brace but no valid JSON', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const mockResponse = new GenerateContentResponse();
    mockResponse.candidates = [
      {
        content: {
          role: 'model',
          parts: [
            {
              text: 'This contains a brace { but no valid json.',
            },
          ],
        },
      },
    ];

    const superSpy = vi
      .spyOn(gemma['apiClient'].models, 'generateContent')
      .mockResolvedValue(mockResponse);

    const responses: LlmResponse[] = [];
    for await (const response of gemma.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses.length).toBe(1);
    const parts = responses[0].content?.parts;
    expect(parts?.length).toBe(1);
    expect(parts?.[0].functionCall).toBeUndefined();
    expect(parts?.[0].text).toBe('This contains a brace { but no valid json.');

    superSpy.mockRestore();
  });

  it('should ignore partial responses', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const originalSuper = Gemini.prototype.generateContentAsync;
    Gemini.prototype.generateContentAsync = async function* () {
      yield {
        content: {
          role: 'model',
          parts: [{text: '{"name": "search_web"}'}],
        },
        partial: true,
      };
    };

    const responses: LlmResponse[] = [];
    for await (const response of gemma.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses.length).toBe(1);
    expect(responses[0].content?.parts?.[0].functionCall).toBeUndefined();
    expect(responses[0].content?.parts?.[0].text).toBe(
      '{"name": "search_web"}',
    );

    Gemini.prototype.generateContentAsync = originalSuper;
  });

  it('should ignore turnComplete responses', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const originalSuper = Gemini.prototype.generateContentAsync;
    Gemini.prototype.generateContentAsync = async function* () {
      yield {
        content: {
          role: 'model',
          parts: [{text: '{"name": "search_web"}'}],
        },
        turnComplete: true,
      };
    };

    const responses: LlmResponse[] = [];
    for await (const response of gemma.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses.length).toBe(1);
    expect(responses[0].content?.parts?.[0].functionCall).toBeUndefined();
    expect(responses[0].content?.parts?.[0].text).toBe(
      '{"name": "search_web"}',
    );

    Gemini.prototype.generateContentAsync = originalSuper;
  });

  it('should ignore response with no content or no parts', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const mockResponse = new GenerateContentResponse();
    mockResponse.candidates = [
      {
        content: {
          role: 'model',
          parts: [], // empty parts
        },
      },
    ];

    const superSpy = vi
      .spyOn(gemma['apiClient'].models, 'generateContent')
      .mockResolvedValue(mockResponse);

    const responses: LlmResponse[] = [];
    for await (const response of gemma.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses.length).toBe(1);
    expect(responses[0].content).toBeUndefined();

    superSpy.mockRestore();
  });

  it('should ignore response with multiple parts', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const mockResponse = new GenerateContentResponse();
    mockResponse.candidates = [
      {
        content: {
          role: 'model',
          parts: [{text: '{"name": "foo"}'}, {text: 'bar'}],
        },
      },
    ];

    const superSpy = vi
      .spyOn(gemma['apiClient'].models, 'generateContent')
      .mockResolvedValue(mockResponse);

    const responses: LlmResponse[] = [];
    for await (const response of gemma.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses.length).toBe(1);
    expect(responses[0].content?.parts?.[0].functionCall).toBeUndefined();
    expect(responses[0].content?.parts?.[1].text).toBe('bar');

    superSpy.mockRestore();
  });

  it('should ignore response with empty text', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const mockResponse = new GenerateContentResponse();
    mockResponse.candidates = [
      {
        content: {
          role: 'model',
          parts: [{}], // empty part
        },
      },
    ];

    const superSpy = vi
      .spyOn(gemma['apiClient'].models, 'generateContent')
      .mockResolvedValue(mockResponse);

    const responses: LlmResponse[] = [];
    for await (const response of gemma.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses.length).toBe(1);
    expect(responses[0].content?.parts?.[0].functionCall).toBeUndefined();

    superSpy.mockRestore();
  });

  it('should ignore valid JSON with missing function name', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const mockResponse = new GenerateContentResponse();
    mockResponse.candidates = [
      {
        content: {
          role: 'model',
          parts: [{text: '{"parameters": {"query": "test"}}'}], // no name/function
        },
      },
    ];

    const superSpy = vi
      .spyOn(gemma['apiClient'].models, 'generateContent')
      .mockResolvedValue(mockResponse);

    const responses: LlmResponse[] = [];
    for await (const response of gemma.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses.length).toBe(1);
    expect(responses[0].content?.parts?.[0].functionCall).toBeUndefined();
    expect(responses[0].content?.parts?.[0].text).toBe(
      '{"parameters": {"query": "test"}}',
    );

    superSpy.mockRestore();
  });

  it('should handle content with undefined parts during preprocess', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    llmRequest.contents = [
      {
        role: 'user',
      } as Content,
    ];
    llmRequest.config = {};

    await preprocessGemmaRequest(gemma, llmRequest);

    expect(llmRequest.contents.length).toBe(1);
    expect(llmRequest.contents[0].parts).toBeUndefined();
  });

  it('should extract function calls with missing parameters or args', async () => {
    const gemma = new Gemma({apiKey: 'test-key'});
    const mockResponse = new GenerateContentResponse();
    mockResponse.candidates = [
      {
        content: {
          role: 'model',
          parts: [{text: '{"name": "search_web"}'}], // missing parameters/args
        },
      },
    ];

    const superSpy = vi
      .spyOn(gemma['apiClient'].models, 'generateContent')
      .mockResolvedValue(mockResponse);

    const responses: LlmResponse[] = [];
    for await (const response of gemma.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses.length).toBe(1);
    const parts = responses[0].content?.parts;
    expect(parts?.length).toBe(1);
    expect(parts?.[0].functionCall).toBeDefined();
    expect(parts?.[0].functionCall?.name).toBe('search_web');
    expect(parts?.[0].functionCall?.args).toEqual({});

    superSpy.mockRestore();
  });
});
