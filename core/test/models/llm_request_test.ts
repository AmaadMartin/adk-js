/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, SchemaUnion, Tool, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  appendInstructions,
  appendTools,
  LlmRequest,
  setOutputSchema,
} from '../../src/models/llm_request.js';
import {BaseTool} from '../../src/tools/base_tool.js';

function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {contents: [], liveConnectConfig: {}, toolsDict: {}, ...overrides};
}

/**
 * A fake tool that either contributes a function declaration or opts out,
 * depending on the `declares` flag.
 */
class FakeTool extends BaseTool {
  constructor(
    name: string,
    private readonly declares = true,
  ) {
    super({name, description: `desc for ${name}`});
  }
  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.declares
      ? {name: this.name, description: this.description}
      : undefined;
  }
  async runAsync(): Promise<unknown> {
    return 'ok';
  }
}

describe('appendInstructions', () => {
  it('creates config and joins instructions when config is absent', () => {
    const req = makeRequest();
    appendInstructions(req, ['a', 'b']);
    expect(req.config).toBeDefined();
    expect(req.config!.systemInstruction).toBe('a\n\nb');
  });

  it('sets systemInstruction while preserving an existing config object', () => {
    const req = makeRequest({config: {}});
    const cfg = req.config;
    appendInstructions(req, ['x']);
    expect(req.config).toBe(cfg);
    expect(req.config!.systemInstruction).toBe('x');
  });

  it('appends to an existing systemInstruction with a blank-line separator', () => {
    const req = makeRequest({config: {systemInstruction: 'existing'}});
    appendInstructions(req, ['more']);
    expect(req.config!.systemInstruction).toBe('existing\n\nmore');
  });

  it('creates config and sets systemInstruction to "" for an empty array', () => {
    const req = makeRequest();
    appendInstructions(req, []);
    expect(req.config).toBeDefined();
    expect(req.config!.systemInstruction).toBe('');
  });
});

describe('appendTools', () => {
  it('is a no-op when tools is an empty array', () => {
    const req = makeRequest();
    appendTools(req, []);
    expect(req.config).toBeUndefined();
    expect(req.toolsDict).toEqual({});
  });

  it('groups all declaring tools from one call into a single entry', () => {
    const req = makeRequest();
    const a = new FakeTool('a');
    const b = new FakeTool('b');
    appendTools(req, [a, b]);
    expect(req.config).toBeDefined();
    const tools = req.config!.tools as Tool[];
    expect(tools).toHaveLength(1);
    expect(tools[0].functionDeclarations!.map((d) => d.name)).toEqual([
      'a',
      'b',
    ]);
    expect(req.toolsDict['a']).toBe(a);
    expect(req.toolsDict['b']).toBe(b);
  });

  it('leaves config untouched when no tool yields a declaration', () => {
    const req = makeRequest();
    appendTools(req, [new FakeTool('x', false)]);
    expect(req.config).toBeUndefined();
    expect(req.toolsDict).toEqual({});
  });

  it('skips non-declaring tools and keeps processing later ones', () => {
    const req = makeRequest();
    const declaring = new FakeTool('yes');
    appendTools(req, [new FakeTool('no', false), declaring]);
    const tools = req.config!.tools as Tool[];
    expect(tools[0].functionDeclarations!.map((d) => d.name)).toEqual(['yes']);
    expect(req.toolsDict).toEqual({yes: declaring});
  });

  it('initializes tools on an existing config that has none', () => {
    const req = makeRequest({config: {systemInstruction: 'keep me'}});
    const cfg = req.config;
    appendTools(req, [new FakeTool('a')]);
    expect(req.config).toBe(cfg);
    expect(req.config!.systemInstruction).toBe('keep me');
    const tools = req.config!.tools as Tool[];
    expect(tools).toHaveLength(1);
    expect(tools[0].functionDeclarations![0].name).toBe('a');
  });

  it('appends a new group without merging into existing tools', () => {
    const existingGroup: Tool = {functionDeclarations: [{name: 'existing'}]};
    const req = makeRequest({config: {tools: [existingGroup]}});
    appendTools(req, [new FakeTool('newTool')]);
    const tools = req.config!.tools as Tool[];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toBe(existingGroup);
    expect(tools[0].functionDeclarations![0].name).toBe('existing');
    expect(tools[1].functionDeclarations).toHaveLength(1);
    expect(tools[1].functionDeclarations![0].name).toBe('newTool');
  });
});

describe('setOutputSchema', () => {
  it('creates config and sets responseSchema and JSON mime type', () => {
    const req = makeRequest();
    const schema: SchemaUnion = {type: Type.OBJECT};
    setOutputSchema(req, schema);
    expect(req.config).toBeDefined();
    expect(req.config!.responseSchema).toBe(schema);
    expect(req.config!.responseMimeType).toBe('application/json');
  });

  it('preserves an existing config while setting schema fields', () => {
    const req = makeRequest({config: {systemInstruction: 'keep me'}});
    const cfg = req.config;
    const schema: SchemaUnion = {type: Type.OBJECT};
    setOutputSchema(req, schema);
    expect(req.config).toBe(cfg);
    expect(req.config!.systemInstruction).toBe('keep me');
    expect(req.config!.responseSchema).toBe(schema);
    expect(req.config!.responseMimeType).toBe('application/json');
  });
});
