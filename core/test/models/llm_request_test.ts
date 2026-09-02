/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool, LlmRequest} from '@google/adk';
import {
  Content,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('appendInstructions with a string array', () => {
  it('sets the system instruction on the first call', () => {
    const request = createRequest();

    appendInstructions(request, ['Be brief.']);

    expect(request.config?.systemInstruction).toBe('Be brief.');
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

    appendInstructions(request, []);

    expect(request.config?.systemInstruction).toBeUndefined();
    expect(request.contents).toEqual([]);
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
