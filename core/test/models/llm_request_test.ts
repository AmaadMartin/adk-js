/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  Session,
  createSession,
} from '@google/adk';
import {Content, FunctionDeclaration, Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  appendTools,
  findToolWithFunctionDeclarations,
  setOutputSchema,
} from '../../src/models/llm_request.js';

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
});
