/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  LlmAgent,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  generateReflectionResponse,
  requireStaticInstruction,
} from '../../src/optimization/gepa_utils.js';

const REFLECTION_CONFIG = {temperature: 0.4};

/** A model that replays a fixed script and reports how it was consumed. */
class ScriptedLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  readonly streamFlags: Array<boolean | undefined> = [];
  delivered = 0;
  closed = false;

  constructor(
    private readonly responses: LlmResponse[],
    private readonly failWith?: Error,
  ) {
    super({model: 'scripted-model'});
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    this.streamFlags.push(stream);
    try {
      for (const response of this.responses) {
        this.delivered += 1;
        yield response;
      }
      if (this.failWith) {
        throw this.failWith;
      }
    } finally {
      this.closed = true;
    }
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not support live connections.');
  }
}

function reflect(
  llm: ScriptedLlm,
  prompt = 'Why did this fail?',
): Promise<string> {
  return generateReflectionResponse({
    llm,
    model: 'gemini-2.5-flash',
    config: REFLECTION_CONFIG,
    prompt,
  });
}

describe('requireStaticInstruction', () => {
  it('returns a static string instruction', () => {
    const agent = new LlmAgent({name: 'a', instruction: 'Be helpful.'});

    expect(requireStaticInstruction(agent)).toBe('Be helpful.');
  });

  it('rejects a request-scoped instruction provider', () => {
    const agent = new LlmAgent({
      name: 'a',
      instruction: async () => 'Be helpful.',
    });

    expect(() => requireStaticInstruction(agent)).toThrow(
      'GEPA optimization requires initialAgent.instruction to be a static' +
        ' string; request-scoped instruction providers cannot be resolved' +
        ' without an invocation context.',
    );
  });
});

describe('generateReflectionResponse', () => {
  it('puts the prompt, the model and the config on a non-streaming request', async () => {
    const llm = new ScriptedLlm([{content: {role: 'model', parts: [{}]}}]);

    await reflect(llm);

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0].model).toBe('gemini-2.5-flash');
    expect(llm.requests[0].config).toBe(REFLECTION_CONFIG);
    expect(llm.requests[0].contents).toEqual([
      {role: 'user', parts: [{text: 'Why did this fail?'}]},
    ]);
    expect(llm.requests[0].toolsDict).toEqual({});
    expect(llm.requests[0].liveConnectConfig).toEqual({});
    expect(llm.streamFlags).toEqual([false]);
  });

  it('joins every non-thought text part', async () => {
    const llm = new ScriptedLlm([
      {
        content: {
          role: 'model',
          parts: [
            {text: 'Reasoning about it. ', thought: true},
            {text: 'Try a shorter '},
            {text: ''},
            {text: 'instruction.'},
          ],
        },
      },
    ]);

    expect(await reflect(llm)).toBe('Try a shorter instruction.');
  });

  it('reads only the first response and closes the generator', async () => {
    const llm = new ScriptedLlm([
      {content: {role: 'model', parts: [{text: 'first'}]}},
      {content: {role: 'model', parts: [{text: 'second'}]}},
    ]);

    expect(await reflect(llm)).toBe('first');
    expect(llm.delivered).toBe(1);
    expect(llm.closed).toBe(true);
  });

  it('returns an empty string when the model yields nothing', async () => {
    const llm = new ScriptedLlm([]);

    expect(await reflect(llm)).toBe('');
    expect(llm.closed).toBe(true);
  });

  it('returns an empty string when the response carries no content', async () => {
    const llm = new ScriptedLlm([{}]);

    expect(await reflect(llm)).toBe('');
  });

  it('returns an empty string when the content carries no parts', async () => {
    const llm = new ScriptedLlm([{content: {role: 'model'}}]);

    expect(await reflect(llm)).toBe('');
  });

  it('closes the generator when the model call fails', async () => {
    const llm = new ScriptedLlm([], new Error('model unavailable'));

    await expect(reflect(llm)).rejects.toThrow('model unavailable');
    expect(llm.closed).toBe(true);
  });
});
