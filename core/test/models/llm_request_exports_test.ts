/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  appendInstructions,
  appendTools,
  BaseTool,
  LlmRequest,
  setOutputSchema,
} from '@google/adk';
import {FunctionDeclaration, Tool, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

function makeRequest(): LlmRequest {
  return {contents: [], liveConnectConfig: {}, toolsDict: {}};
}

class EchoTool extends BaseTool {
  constructor() {
    super({name: 'echo', description: 'echoes its input'});
  }

  override _getDeclaration(): FunctionDeclaration {
    return {name: this.name, description: this.description};
  }

  async runAsync(): Promise<unknown> {
    return 'ok';
  }
}

describe('llm_request helpers exported from @google/adk', () => {
  it('appendInstructions is importable and sets systemInstruction', () => {
    const request = makeRequest();
    appendInstructions(request, ['first', 'second']);
    expect(request.config?.systemInstruction).toBe('first\n\nsecond');
  });

  it('appendTools is importable and registers the declaration', () => {
    const request = makeRequest();
    const tool = new EchoTool();
    appendTools(request, [tool]);
    const tools = request.config?.tools as Tool[];
    expect(tools[0].functionDeclarations?.[0].name).toBe('echo');
    expect(request.toolsDict['echo']).toBe(tool);
  });

  it('setOutputSchema is importable and sets schema and mime type', () => {
    const request = makeRequest();
    const schema = {type: Type.OBJECT};
    setOutputSchema(request, schema);
    expect(request.config?.responseSchema).toBe(schema);
    expect(request.config?.responseMimeType).toBe('application/json');
  });
});
