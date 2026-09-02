/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  Session,
} from '@google/adk';
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
  appendDynamicInstructions,
  appendInstructions,
  appendTools,
  finalizeDynamicInstructions,
  findToolWithFunctionDeclarations,
  insertTransientUserContent,
  MISSING_OUTPUT_SCHEMA_MESSAGE,
  setOutputSchema,
} from '../../src/models/llm_request.js';
import {logger} from '../../src/utils/logger.js';

function createRequest(contents: Content[] = []): LlmRequest {
  return {contents, toolsDict: {}, liveConnectConfig: {}, config: {}};
}

function createBareRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
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

function makeSession(): Session {
  return createSession({id: 'test-session', appName: 'test-app'});
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'root'}),
      session: makeSession(),
      pluginManager: new PluginManager(),
      runConfig: {},
    }),
  });
}

const DECLARATION_A: FunctionDeclaration = {name: 'a', description: 'a'};
const DECLARATION_B: FunctionDeclaration = {name: 'b', description: 'b'};

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

  it('appends beside a Tool whose declaration list is absent', () => {
    const request = createRequest();
    request.config = {tools: [{functionDeclarations: undefined}]};

    appendTools(request, [createStubTool('dummy_tool')]);

    expect(request.config.tools).toHaveLength(2);
    expect(request.config.tools?.[0]).toEqual({
      functionDeclarations: undefined,
    });
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

describe('appendInstructions on a request without a config', () => {
  describe('string array', () => {
    it('leaves the request untouched for an empty array', () => {
      const request = createBareRequest();

      appendInstructions(request, []);

      expect(request.config?.systemInstruction).toBeUndefined();
      expect(request.contents).toEqual([]);
    });

    it('sets the system instruction on the first append', () => {
      const request = createBareRequest();

      appendInstructions(request, ['First', 'Second']);

      expect(request.config?.systemInstruction).toBe('First\n\nSecond');
    });

    it('joins a later append onto the existing system instruction', () => {
      const request = createBareRequest();

      appendInstructions(request, ['First']);
      appendInstructions(request, ['Second']);

      expect(request.config?.systemInstruction).toBe('First\n\nSecond');
    });
  });

  describe('content', () => {
    it('joins the text parts into the system instruction', () => {
      const request = createBareRequest();

      appendInstructions(request, {
        role: 'user',
        parts: [{text: 'First part'}, {text: 'Second part'}],
      });

      expect(request.config?.systemInstruction).toBe(
        'First part\n\nSecond part',
      );
      expect(request.contents).toEqual([]);
    });

    it('adds a user content for an inline data part', () => {
      const request = createBareRequest();

      appendInstructions(request, {
        role: 'user',
        parts: [{inlineData: {data: 'ZGF0YQ==', mimeType: 'image/png'}}],
      });

      expect(request.config?.systemInstruction).toBe(
        '[Reference to inline binary data: inline_data_0 (type: image/png)]',
      );
      expect(request.contents).toHaveLength(1);
      expect(request.contents[0].role).toBe('user');
      expect(request.contents[0].parts?.[0].text).toBe(
        'Referenced inline data: inline_data_0',
      );
      expect(request.contents[0].parts?.[1].inlineData?.data).toBe('ZGF0YQ==');
    });

    it('adds a user content for a file data part', () => {
      const request = createBareRequest();

      appendInstructions(request, {
        role: 'user',
        parts: [{fileData: {fileUri: 'files/doc', mimeType: 'text/plain'}}],
      });

      expect(request.config?.systemInstruction).toBe(
        '[Reference to file data: file_data_0 (URI: files/doc, type: text/plain)]',
      );
      expect(request.contents).toHaveLength(1);
      expect(request.contents[0].parts?.[0].text).toBe(
        'Referenced file data: file_data_0',
      );
      expect(request.contents[0].parts?.[1].fileData?.fileUri).toBe(
        'files/doc',
      );
    });

    it('numbers inline and file references from one counter', () => {
      const request = createBareRequest();

      appendInstructions(request, {
        role: 'user',
        parts: [
          {inlineData: {data: 'YQ==', mimeType: 'image/png'}},
          {fileData: {fileUri: 'files/a', mimeType: 'text/plain'}},
          {inlineData: {data: 'Yg==', mimeType: 'image/jpeg'}},
        ],
      });

      expect(request.config?.systemInstruction).toContain('inline_data_0');
      expect(request.config?.systemInstruction).toContain('file_data_1');
      expect(request.config?.systemInstruction).toContain('inline_data_2');
    });

    it('names a display name ahead of the other reference fields', () => {
      const request = createBareRequest();

      appendInstructions(request, {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: 'YQ==',
              mimeType: 'image/png',
              displayName: 'shot.png',
            },
          },
          {
            fileData: {
              fileUri: 'files/a',
              mimeType: 'text/plain',
              displayName: 'notes.txt',
            },
          },
        ],
      });

      expect(request.config?.systemInstruction).toBe(
        "[Reference to inline binary data: inline_data_0 ('shot.png', type:" +
          " image/png)]\n\n[Reference to file data: file_data_1 ('notes.txt'," +
          ' URI: files/a, type: text/plain)]',
      );
    });

    it('omits the descriptor when the part carries no describable field', () => {
      const request = createBareRequest();

      appendInstructions(request, {
        role: 'user',
        parts: [{inlineData: {data: 'YQ=='}}, {fileData: {}}],
      });

      expect(request.config?.systemInstruction).toBe(
        '[Reference to inline binary data: inline_data_0]\n\n' +
          '[Reference to file data: file_data_1]',
      );
    });

    it('skips a part that is neither text nor data', () => {
      const request = createBareRequest();

      appendInstructions(request, {
        role: 'user',
        parts: [{functionCall: {name: 'do_it'}}, {text: 'Only this'}],
      });

      expect(request.config?.systemInstruction).toBe('Only this');
      expect(request.contents).toEqual([]);
    });

    it('adds nothing for a content without parts', () => {
      const request = createBareRequest();

      appendInstructions(request, {role: 'user'});

      expect(request.config?.systemInstruction).toBeUndefined();
      expect(request.contents).toEqual([]);
    });
  });

  it('leaves a non-string system instruction untouched', () => {
    const request = createBareRequest();
    const existing: Content = {role: 'user', parts: [{text: 'Structured'}]};
    request.config = {systemInstruction: existing};

    appendInstructions(request, ['Appended']);

    expect(request.config.systemInstruction).toBe(existing);
  });

  it('rejects an argument that is neither a string array nor a content', () => {
    const request = createBareRequest();

    expect(() => appendInstructions(request, {})).toThrow(TypeError);
    expect(() => appendInstructions(request, {})).toThrow(
      'instructions must be string[] or Content, got object.',
    );
  });
});

describe('appendDynamicInstructions', () => {
  it('accumulates entries across successive calls, in order', () => {
    const request = createRequest();

    appendDynamicInstructions(request, ['first', 'second']);
    appendDynamicInstructions(request, ['third']);

    expect(request.dynamicInstructions).toEqual(['first', 'second', 'third']);
  });

  it('is a no-op for an empty array', () => {
    const request = createRequest();

    appendDynamicInstructions(request, []);

    expect(request.dynamicInstructions).toBeUndefined();
  });

  it('leaves the system instruction alone', () => {
    const request = createRequest();
    appendInstructions(request, ['Be brief.']);

    appendDynamicInstructions(request, ['Prefer report.pdf.']);

    expect(request.config?.systemInstruction).toBe('Be brief.');
  });
});

describe('finalizeDynamicInstructions', () => {
  it('joins the accumulated entries with a blank line', () => {
    const request = createRequest();
    appendDynamicInstructions(request, ['first', 'second']);

    finalizeDynamicInstructions(request);

    expect(request.config?.systemInstruction).toBe('first\n\nsecond');
  });

  it('appends after an instruction already set, separated by a blank line', () => {
    const request = createRequest();
    appendInstructions(request, ['Be brief.']);
    appendDynamicInstructions(request, ['Prefer report.pdf.']);

    finalizeDynamicInstructions(request);

    expect(request.config?.systemInstruction).toBe(
      'Be brief.\n\nPrefer report.pdf.',
    );
  });

  it('clears the accumulator, so a second call adds nothing', () => {
    const request = createRequest();
    appendDynamicInstructions(request, ['Prefer report.pdf.']);

    finalizeDynamicInstructions(request);
    finalizeDynamicInstructions(request);

    expect(request.config?.systemInstruction).toBe('Prefer report.pdf.');
    expect(request.dynamicInstructions).toEqual([]);
  });

  it('is a no-op when nothing was accumulated', () => {
    const request = createRequest();

    finalizeDynamicInstructions(request);

    expect(request.config?.systemInstruction).toBeUndefined();
  });
});

function texts(request: LlmRequest): Array<string | undefined> {
  return request.contents.map((content) => content.parts?.[0]?.text);
}

describe('insertTransientUserContent — turn boundary', () => {
  it('leaves the contents untouched when there is nothing to insert', () => {
    const request = createRequest([createUserContent('question')]);

    insertTransientUserContent(request, []);

    expect(texts(request)).toEqual(['question']);
  });

  it('inserts before the latest run of user contents', () => {
    const request = createRequest([
      createUserContent('older question'),
      createModelContent('answer'),
      createUserContent('question'),
      createUserContent('follow-up'),
    ]);

    insertTransientUserContent(request, [createUserContent('instruction')]);

    expect(texts(request)).toEqual([
      'older question',
      'answer',
      'instruction',
      'question',
      'follow-up',
    ]);
  });

  it('inserts after a user content that carries a function response', () => {
    const request = createRequest([
      createUserContent('question'),
      createModelContent([
        {functionCall: {id: 'call_1', name: 'tool', args: {}}},
      ]),
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_1',
              name: 'tool',
              response: {ok: true},
            },
          },
        ],
      },
    ]);

    insertTransientUserContent(request, [createUserContent('instruction')]);

    expect(request.contents).toHaveLength(4);
    expect(request.contents[2].parts?.[0]?.functionResponse?.id).toBe('call_1');
    expect(request.contents[3].parts?.[0]?.text).toBe('instruction');
  });

  it('appends at the end when the last content is a model turn', () => {
    const request = createRequest([
      createUserContent('question'),
      createModelContent('answer'),
    ]);

    insertTransientUserContent(request, [createUserContent('instruction')]);

    expect(texts(request)).toEqual(['question', 'answer', 'instruction']);
  });

  it('inserts at the start when every content is an ordinary user turn', () => {
    const request = createRequest([
      createUserContent('question'),
      createUserContent('follow-up'),
    ]);

    insertTransientUserContent(request, [createUserContent('instruction')]);

    expect(texts(request)).toEqual(['instruction', 'question', 'follow-up']);
  });

  it('keeps the order of several inserted contents', () => {
    const request = createRequest([createUserContent('question')]);

    insertTransientUserContent(request, [
      createUserContent('first'),
      createUserContent('second'),
    ]);

    expect(texts(request)).toEqual(['first', 'second', 'question']);
  });
});

describe('findToolWithFunctionDeclarations', () => {
  it('returns undefined when the request has no config', () => {
    expect(
      findToolWithFunctionDeclarations(createBareRequest()),
    ).toBeUndefined();
  });

  it('returns undefined when the config carries no tool list', () => {
    const request = createRequest();

    expect(findToolWithFunctionDeclarations(request)).toBeUndefined();
  });

  it('returns undefined for an empty tool list', () => {
    const request = createRequest();
    request.config = {tools: []};

    expect(findToolWithFunctionDeclarations(request)).toBeUndefined();
  });

  it('skips an entry whose declaration list is empty', () => {
    const request = createRequest();
    request.config = {
      tools: [
        {functionDeclarations: []},
        {functionDeclarations: [DECLARATION_A]},
      ],
    };

    expect(findToolWithFunctionDeclarations(request)).toBe(
      request.config.tools?.[1],
    );
  });

  it('skips an entry whose declaration list is absent', () => {
    const request = createRequest();
    request.config = {
      tools: [
        {functionDeclarations: undefined},
        {functionDeclarations: [DECLARATION_A]},
      ],
    };

    expect(findToolWithFunctionDeclarations(request)).toBe(
      request.config.tools?.[1],
    );
  });

  it('skips a built-in tool entry', () => {
    const request = createRequest();
    request.config = {tools: [{googleSearch: {}}]};

    expect(findToolWithFunctionDeclarations(request)).toBeUndefined();
  });

  it('returns the first of two entries that carry declarations', () => {
    const request = createRequest();
    request.config = {
      tools: [
        {functionDeclarations: [DECLARATION_A]},
        {functionDeclarations: [DECLARATION_B]},
      ],
    };

    expect(findToolWithFunctionDeclarations(request)).toBe(
      request.config.tools?.[0],
    );
  });
});

describe('appendTools consolidation', () => {
  it('merges into an entry that already carries declarations', () => {
    const request = createRequest();
    request.config = {tools: [{functionDeclarations: [DECLARATION_A]}]};

    appendTools(request, [createStubTool('dummy_tool')]);

    expect(request.config?.tools).toHaveLength(1);
    expect(
      findToolWithFunctionDeclarations(request)?.functionDeclarations.map(
        (declaration) => declaration.name,
      ),
    ).toEqual(['a', 'dummy_tool']);
  });

  it('appends a new entry when the only entry has an empty declaration list', () => {
    const request = createRequest();
    const emptyEntry = {functionDeclarations: []};
    request.config = {tools: [emptyEntry]};

    appendTools(request, [createStubTool('dummy_tool')]);

    expect(request.config?.tools).toHaveLength(2);
    expect(emptyEntry.functionDeclarations).toEqual([]);
    expect(
      findToolWithFunctionDeclarations(request)?.functionDeclarations.map(
        (declaration) => declaration.name,
      ),
    ).toEqual(['dummy_tool']);
  });

  it('appends a new entry when the only entry has an absent declaration list', () => {
    const request = createRequest();
    request.config = {tools: [{functionDeclarations: undefined}]};

    appendTools(request, [createStubTool('dummy_tool')]);

    expect(request.config?.tools).toHaveLength(2);
    expect(request.config.tools?.[0]).toEqual({
      functionDeclarations: undefined,
    });
  });

  it('leaves a built-in tool entry alone and appends beside it', () => {
    const request = createRequest();
    request.config = {tools: [{googleSearch: {}}]};

    appendTools(request, [createStubTool('dummy_tool')]);

    expect(request.config?.tools).toHaveLength(2);
    expect(request.config.tools?.[0]).toEqual({googleSearch: {}});
  });

  it('consolidates several tools into a single entry', () => {
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

  it('consolidates across successive calls', () => {
    const request = createRequest();

    appendTools(request, [createStubTool('one')]);
    appendTools(request, [createStubTool('two')]);

    expect(request.config?.tools).toHaveLength(1);
    expect(
      findToolWithFunctionDeclarations(request)?.functionDeclarations.map(
        (declaration) => declaration.name,
      ),
    ).toEqual(['one', 'two']);
  });

  it('creates the config and the tool list when the request has neither', () => {
    const request = createBareRequest();

    appendTools(request, [createStubTool('dummy_tool')]);

    expect(request.config?.tools).toEqual([
      {
        functionDeclarations: [
          {name: 'dummy_tool', description: expect.any(String)},
        ],
      },
    ]);
  });

  it('is a no-op for an empty tool list', () => {
    const request = createRequest();

    appendTools(request, []);

    expect(request.config?.tools).toBeUndefined();
    expect(request.toolsDict).toEqual({});
  });

  it('is a no-op for a tool that has no declaration', () => {
    const request = createRequest();

    appendTools(request, [new StubTool('no_decl_tool')]);

    expect(request.config?.tools).toBeUndefined();
    expect(request.toolsDict).toEqual({});
  });
});

describe('appendTools and BaseTool.processLlmRequest agree', () => {
  it('produce the same single entry for the same three tools', async () => {
    const viaAppend = createRequest();
    const viaProcess = createRequest();
    const toolContext = createToolContext();

    appendTools(viaAppend, [
      createStubTool('one'),
      createStubTool('two'),
      createStubTool('three'),
    ]);
    for (const name of ['one', 'two', 'three']) {
      await createStubTool(name).processLlmRequest({
        toolContext,
        llmRequest: viaProcess,
      });
    }

    expect(viaProcess.config?.tools).toEqual(viaAppend.config?.tools);
    expect(viaAppend.config?.tools).toHaveLength(1);
    expect(
      findToolWithFunctionDeclarations(viaAppend)?.functionDeclarations,
    ).toHaveLength(3);
  });

  it('both skip an entry whose declaration list is empty', async () => {
    const viaAppend = createRequest();
    const viaProcess = createRequest();
    viaAppend.config = {tools: [{functionDeclarations: []}]};
    viaProcess.config = {tools: [{functionDeclarations: []}]};

    appendTools(viaAppend, [createStubTool('one')]);
    await createStubTool('one').processLlmRequest({
      toolContext: createToolContext(),
      llmRequest: viaProcess,
    });

    expect(viaProcess.config?.tools).toEqual(viaAppend.config.tools);
    expect(viaAppend.config?.tools).toHaveLength(2);
  });
});

describe('setOutputSchema', () => {
  const SCHEMA: Schema = {
    type: Type.OBJECT,
    properties: {answer: {type: Type.STRING}},
  };

  it('sets the schema and forces the JSON mime type', () => {
    const request = createRequest();

    setOutputSchema(request, SCHEMA);

    expect(request.config?.responseSchema).toBe(SCHEMA);
    expect(request.config?.responseMimeType).toBe('application/json');
  });

  it('creates the config when the request has none', () => {
    const request = createBareRequest();

    setOutputSchema(request, SCHEMA);

    expect(request.config?.responseSchema).toBe(SCHEMA);
    expect(request.config?.responseMimeType).toBe('application/json');
  });

  it('throws and leaves the request untouched for an undefined schema', () => {
    const request = createRequest();

    expect(() => {
      setOutputSchema(request, undefined);
    }).toThrowError(MISSING_OUTPUT_SCHEMA_MESSAGE);
    expect(request.config?.responseSchema).toBeUndefined();
    expect(request.config?.responseMimeType).toBeUndefined();
  });

  it('throws and leaves the request untouched for a null schema', () => {
    const request = createRequest();

    expect(() => {
      setOutputSchema(request, null);
    }).toThrowError(MISSING_OUTPUT_SCHEMA_MESSAGE);
    expect(request.config?.responseSchema).toBeUndefined();
    expect(request.config?.responseMimeType).toBeUndefined();
  });

  it('does not create the config when it throws', () => {
    const request = createBareRequest();

    expect(() => {
      setOutputSchema(request, undefined);
    }).toThrowError(MISSING_OUTPUT_SCHEMA_MESSAGE);
    expect(request.config).toBeUndefined();
  });
});
