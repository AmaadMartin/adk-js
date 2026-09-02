/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool, LlmRequest} from '@google/adk';
import {
  Content,
  createModelContent,
  createUserContent,
  FunctionDeclaration,
  Schema,
  Type,
} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  appendInstructions,
  appendTools,
  findToolWithFunctionDeclarations,
  insertTransientUserContent,
  setOutputSchema,
} from '../../src/models/llm_request.js';
import {logger} from '../../src/utils/logger.js';

function createRequest(contents: Content[] = []): LlmRequest {
  return {contents, toolsDict: {}, liveConnectConfig: {}, config: {}};
}

class StubTool extends BaseTool {
  constructor(
    name: string,
    private readonly declaration?: FunctionDeclaration,
  ) {
    super({name, description: `${name} description`});
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.declaration;
  }

  async runAsync(): Promise<unknown> {
    return null;
  }
}

function createStubTool(name: string): StubTool {
  return new StubTool(name, {name, description: `${name} description`});
}

const FUNCTION_RESPONSE_CONTENT: Content = {
  role: 'user',
  parts: [{functionResponse: {name: 'lookup', response: {result: 'done'}}}],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('appendInstructions with a string array', () => {
  it('sets the system instruction on the first call', () => {
    const request = createRequest();

    const userContents = appendInstructions(request, ['Be brief.']);

    expect(request.config?.systemInstruction).toBe('Be brief.');
    expect(userContents).toEqual([]);
  });

  it('joins a later call onto the existing system instruction', () => {
    const request = createRequest();

    appendInstructions(request, ['Be brief.']);
    appendInstructions(request, ['Cite sources.', 'Stay on topic.']);

    expect(request.config?.systemInstruction).toBe(
      'Be brief.\n\nCite sources.\n\nStay on topic.',
    );
  });

  it('leaves the request untouched for an empty array', () => {
    const request = createRequest();

    const userContents = appendInstructions(request, []);

    expect(request.config?.systemInstruction).toBeUndefined();
    expect(request.contents).toEqual([]);
    expect(userContents).toEqual([]);
  });

  it('creates the config when the request has none', () => {
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    appendInstructions(request, ['Be brief.']);

    expect(request.config?.systemInstruction).toBe('Be brief.');
  });
});

describe('appendInstructions with a Content', () => {
  it('extracts a single text part', () => {
    const request = createRequest();

    const userContents = appendInstructions(
      request,
      createUserContent('Be brief.'),
    );

    expect(request.config?.systemInstruction).toBe('Be brief.');
    expect(userContents).toEqual([]);
    expect(request.hasStaticInstruction).toBeUndefined();
  });

  it('joins several text parts with a blank line', () => {
    const request = createRequest();

    appendInstructions(request, {
      role: 'user',
      parts: [{text: 'Be brief.'}, {text: 'Cite sources.'}],
    });

    expect(request.config?.systemInstruction).toBe(
      'Be brief.\n\nCite sources.',
    );
  });

  it('ignores the content role', () => {
    const request = createRequest();

    appendInstructions(request, {role: 'system', parts: [{text: 'Be brief.'}]});

    expect(request.config?.systemInstruction).toBe('Be brief.');
  });

  it('is a no-op for a Content without parts', () => {
    const request = createRequest();

    const userContents = appendInstructions(request, {role: 'user'});

    expect(userContents).toEqual([]);
    expect(request.config?.systemInstruction).toBeUndefined();
    expect(request.contents).toEqual([]);
  });

  it('skips empty and absent text parts', () => {
    const request = createRequest();

    appendInstructions(request, {
      role: 'user',
      parts: [{text: 'Valid text'}, {text: ''}, {}, {text: 'More valid text'}],
    });

    expect(request.config?.systemInstruction).toBe(
      'Valid text\n\nMore valid text',
    );
  });

  it('appends onto a system instruction set by a string array', () => {
    const request = createRequest();

    appendInstructions(request, ['Be brief.']);
    appendInstructions(request, createUserContent('Cite sources.'));

    expect(request.config?.systemInstruction).toBe(
      'Be brief.\n\nCite sources.',
    );
  });
});

describe('appendInstructions non-text part references', () => {
  it('replaces an inline data part with a reference', () => {
    const request = createRequest();
    const inlineData = {data: 'ZmlsZV9kYXRh', mimeType: 'text/plain'};

    const userContents = appendInstructions(request, {
      role: 'user',
      parts: [{text: 'Text instruction'}, {inlineData}, {text: 'More text'}],
    });

    expect(request.config?.systemInstruction).toBe(
      'Text instruction\n\n' +
        '[Reference to inline binary data: inline_data_0 (type: text/plain)]' +
        '\n\nMore text',
    );
    expect(userContents).toHaveLength(1);
    expect(userContents[0].role).toBe('user');
    expect(userContents[0].parts).toEqual([
      {text: 'Referenced inline data: inline_data_0'},
      {inlineData},
    ]);
    expect(request.contents).toEqual(userContents);
    expect(request.hasStaticInstruction).toBe(true);
  });

  it('appends the reference to an existing system instruction', () => {
    const request = createRequest();
    request.config = {systemInstruction: 'Initial'};

    appendInstructions(request, {
      role: 'user',
      parts: [{inlineData: {data: 'ZmlsZV9kYXRh', mimeType: 'text/plain'}}],
    });

    expect(request.config.systemInstruction).toBe(
      'Initial\n\n[Reference to inline binary data: inline_data_0 ' +
        '(type: text/plain)]',
    );
  });

  it('numbers inline and file parts in one sequence', () => {
    const request = createRequest();
    const inlineData = {
      data: 'dGVzdF9kYXRh',
      mimeType: 'image/png',
      displayName: 'test.png',
    };
    const fileData = {
      fileUri: 'files/doc123',
      mimeType: 'text/plain',
      displayName: 'document.txt',
    };

    const userContents = appendInstructions(request, {
      role: 'user',
      parts: [
        {text: 'Analyze this:'},
        {inlineData},
        {text: 'Focus on details.'},
        {fileData},
      ],
    });

    expect(request.config?.systemInstruction).toBe(
      'Analyze this:\n\n' +
        "[Reference to inline binary data: inline_data_0 ('test.png', " +
        'type: image/png)]\n\n' +
        'Focus on details.\n\n' +
        "[Reference to file data: file_data_1 ('document.txt', " +
        'URI: files/doc123, type: text/plain)]',
    );
    expect(userContents).toHaveLength(2);
    expect(userContents[0].parts).toEqual([
      {text: 'Referenced inline data: inline_data_0'},
      {inlineData},
    ]);
    expect(userContents[1].parts).toEqual([
      {text: 'Referenced file data: file_data_1'},
      {fileData},
    ]);
    expect(request.contents).toEqual(userContents);
  });

  it('omits the suffix when a part carries no descriptor', () => {
    const request = createRequest();

    appendInstructions(request, {
      role: 'user',
      parts: [{inlineData: {data: 'ZGF0YQ=='}}, {fileData: {}}],
    });

    expect(request.config?.systemInstruction).toBe(
      '[Reference to inline binary data: inline_data_0]\n\n' +
        '[Reference to file data: file_data_1]',
    );
  });

  it('describes a file part that has only a URI', () => {
    const request = createRequest();

    appendInstructions(request, {
      role: 'user',
      parts: [{fileData: {fileUri: 'files/doc123'}}],
    });

    expect(request.config?.systemInstruction).toBe(
      '[Reference to file data: file_data_0 (URI: files/doc123)]',
    );
  });
});

describe('appendInstructions with a non-string system instruction', () => {
  it('refuses a string array append and warns', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const systemInstruction = createUserContent('Preset content');
    const request = createRequest();
    request.config = {systemInstruction};

    appendInstructions(request, ['Be brief.']);

    expect(request.config.systemInstruction).toBe(systemInstruction);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Cannot append to systemInstruction of unsupported type: object',
      ),
    );
  });

  it('refuses a Content append and warns', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const systemInstruction = createUserContent('Preset content');
    const request = createRequest();
    request.config = {systemInstruction};

    appendInstructions(request, createUserContent('Be brief.'));

    expect(request.config.systemInstruction).toBe(systemInstruction);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('appendInstructions with an unsupported input', () => {
  it('rejects an object carrying neither role nor parts', () => {
    const request = createRequest();

    expect(() => appendInstructions(request, {})).toThrow(TypeError);
    expect(() => appendInstructions(request, {})).toThrow(
      'instructions must be string[] or Content, got object.',
    );
    expect(request.config?.systemInstruction).toBeUndefined();
    expect(request.contents).toEqual([]);
  });

  it('rejects an array holding a non-string', () => {
    // Parsed JSON is the realistic way a non-string reaches a `string[]`
    // parameter: the guard exists for callers TypeScript does not check.
    const parsed: string[] = JSON.parse('["valid string", 123]');
    const request = createRequest();

    expect(() => appendInstructions(request, parsed)).toThrow(TypeError);
    expect(request.config?.systemInstruction).toBeUndefined();
  });

  it('accepts a Content that carries only parts', () => {
    const request = createRequest();

    appendInstructions(request, {parts: [{text: 'Be brief.'}]});

    expect(request.config?.systemInstruction).toBe('Be brief.');
  });
});

describe('appendTools', () => {
  it('creates the tool list and registers the tool', () => {
    const request = createRequest();
    const tool = createStubTool('dummy_tool');

    appendTools(request, [tool]);

    expect(request.config?.tools).toEqual([
      {
        functionDeclarations: [
          {name: 'dummy_tool', description: expect.any(String)},
        ],
      },
    ]);
    expect(request.toolsDict['dummy_tool']).toBe(tool);
  });

  it('consolidates several tools into a single Tool', () => {
    const request = createRequest();

    appendTools(request, [
      createStubTool('one'),
      createStubTool('two'),
      createStubTool('three'),
    ]);

    expect(request.config?.tools).toHaveLength(1);
    expect(
      findToolWithFunctionDeclarations(request)?.functionDeclarations,
    ).toHaveLength(3);
  });

  it('is a no-op for an empty list', () => {
    const request = createRequest();

    appendTools(request, []);

    expect(request.config?.tools).toBeUndefined();
    expect(request.toolsDict).toEqual({});
  });

  it('neither declares nor registers a tool without a declaration', () => {
    const request = createRequest();

    appendTools(request, [new StubTool('no_decl_tool')]);

    expect(request.config?.tools).toBeUndefined();
    expect(request.toolsDict).toEqual({});
  });

  it('merges into a Tool that already carries declarations', () => {
    const request = createRequest();
    request.config = {
      tools: [
        {
          functionDeclarations: [
            {name: 'existing_tool', description: 'An existing tool'},
          ],
        },
      ],
    };

    appendTools(request, [createStubTool('dummy_tool')]);

    expect(request.config.tools).toHaveLength(1);
    const declarations =
      findToolWithFunctionDeclarations(request)?.functionDeclarations ?? [];
    expect(declarations.map((declaration) => declaration.name)).toEqual([
      'existing_tool',
      'dummy_tool',
    ]);
  });

  it('merges into a Tool whose declaration list is absent', () => {
    const request = createRequest();
    request.config = {tools: [{functionDeclarations: undefined}]};

    appendTools(request, [createStubTool('dummy_tool')]);

    expect(request.config.tools).toHaveLength(1);
    expect(
      findToolWithFunctionDeclarations(request)?.functionDeclarations,
    ).toHaveLength(1);
  });

  it('leaves a tool without function declarations alone', () => {
    const request = createRequest();
    request.config = {tools: [{googleSearch: {}}]};

    appendTools(request, [createStubTool('dummy_tool')]);

    expect(request.config.tools).toHaveLength(2);
  });

  it('warns when a tool name shadows a registered tool', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const request = createRequest();
    const survivor = createStubTool('search');

    appendTools(request, [createStubTool('search'), survivor]);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Duplicate tool name 'search'"),
    );
    expect(Object.keys(request.toolsDict)).toEqual(['search']);
    expect(request.toolsDict['search']).toBe(survivor);
  });

  it('does not report a phantom duplicate for an inherited name', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const request = createRequest();

    appendTools(request, [createStubTool('toString')]);

    expect(warn).not.toHaveBeenCalled();
    expect(request.toolsDict['toString']).toBeInstanceOf(StubTool);
  });
});

describe('findToolWithFunctionDeclarations', () => {
  it('returns undefined when the request has no config', () => {
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    expect(findToolWithFunctionDeclarations(request)).toBeUndefined();
  });
});

describe('insertTransientUserContent', () => {
  it('leaves the request untouched when there is nothing to insert', () => {
    const request = createRequest([createUserContent('current query')]);

    insertTransientUserContent(request, []);

    expect(request.contents).toEqual([createUserContent('current query')]);
  });

  it('inserts at index 0 when the request has no contents', () => {
    const request = createRequest([]);

    insertTransientUserContent(request, [createUserContent('memory')]);

    expect(request.contents).toEqual([createUserContent('memory')]);
  });

  it('inserts before a history of only user contents', () => {
    const request = createRequest([
      createUserContent('first'),
      createUserContent('second'),
    ]);

    insertTransientUserContent(request, [createUserContent('memory')]);

    expect(request.contents[0]).toEqual(createUserContent('memory'));
    expect(request.contents).toHaveLength(3);
  });

  it('inserts after the last model content', () => {
    const request = createRequest([
      createUserContent('historical question'),
      createModelContent('historical answer'),
      createUserContent('current query'),
    ]);

    insertTransientUserContent(request, [createUserContent('memory')]);

    expect(request.contents[2]).toEqual(createUserContent('memory'));
    expect(request.contents[3]).toEqual(createUserContent('current query'));
  });

  it('inserts after a trailing function response', () => {
    const request = createRequest([
      createUserContent('current query'),
      createModelContent({functionCall: {name: 'lookup', args: {}}}),
      FUNCTION_RESPONSE_CONTENT,
    ]);

    insertTransientUserContent(request, [createUserContent('memory')]);

    expect(request.contents[2]).toBe(FUNCTION_RESPONSE_CONTENT);
    expect(request.contents[3]).toEqual(createUserContent('memory'));
  });

  it('walks past a user content that has no parts', () => {
    const request = createRequest([
      createModelContent('historical answer'),
      {role: 'user'},
    ]);

    insertTransientUserContent(request, [createUserContent('memory')]);

    expect(request.contents[1]).toEqual(createUserContent('memory'));
    expect(request.contents[2]).toEqual({role: 'user'});
  });

  it('keeps the relative order of several inserted contents', () => {
    const request = createRequest([createUserContent('current query')]);

    insertTransientUserContent(request, [
      createUserContent('first'),
      createUserContent('second'),
    ]);

    expect(request.contents).toEqual([
      createUserContent('first'),
      createUserContent('second'),
      createUserContent('current query'),
    ]);
  });

  it('mutates the contents array in place', () => {
    const contents = [createUserContent('current query')];
    const request = createRequest(contents);

    insertTransientUserContent(request, [createUserContent('memory')]);

    expect(request.contents).toBe(contents);
    expect(contents).toHaveLength(2);
  });
});

describe('insertTransientUserContent with a static instruction', () => {
  it('places the first insert at the front and records the prefix end', () => {
    const request = createRequest([
      createModelContent('historical answer'),
      createUserContent('current query'),
    ]);
    request.hasStaticInstruction = true;

    insertTransientUserContent(request, [
      createUserContent('static a'),
      createUserContent('static b'),
    ]);

    expect(request.contents[0]).toEqual(createUserContent('static a'));
    expect(request.contents[1]).toEqual(createUserContent('static b'));
    expect(request.staticInstructionPrefixEndIndex).toBe(2);
  });

  it('never inserts before the recorded prefix', () => {
    const request = createRequest([createUserContent('current query')]);
    request.hasStaticInstruction = true;

    insertTransientUserContent(request, [createUserContent('static')]);
    insertTransientUserContent(request, [createUserContent('memory')]);

    expect(request.contents).toEqual([
      createUserContent('static'),
      createUserContent('memory'),
      createUserContent('current query'),
    ]);
    expect(request.staticInstructionPrefixEndIndex).toBe(1);
  });

  it('keeps a later boundary when it is after the prefix', () => {
    const request = createRequest([]);
    request.hasStaticInstruction = true;

    insertTransientUserContent(request, [createUserContent('static')]);
    request.contents.push(createModelContent('answer'));
    insertTransientUserContent(request, [createUserContent('memory')]);

    expect(request.contents).toEqual([
      createUserContent('static'),
      createModelContent('answer'),
      createUserContent('memory'),
    ]);
  });

  it('does not clamp when the request has no static instruction', () => {
    const request = createRequest([createUserContent('current query')]);
    request.staticInstructionPrefixEndIndex = 1;

    insertTransientUserContent(request, [createUserContent('memory')]);

    expect(request.contents[0]).toEqual(createUserContent('memory'));
  });
});

describe('setOutputSchema', () => {
  it('sets the schema and forces the JSON mime type', () => {
    const request = createRequest();
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {answer: {type: Type.STRING}},
    };

    setOutputSchema(request, schema);

    expect(request.config?.responseSchema).toBe(schema);
    expect(request.config?.responseMimeType).toBe('application/json');
  });
});
