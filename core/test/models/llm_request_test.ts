/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ContentUnion} from '@google/genai';
import {describe, expect, it} from 'vitest';
import type {LlmRequest} from '../../src/models/llm_request.js';
import {appendInstructions} from '../../src/models/llm_request.js';

/** Builds a request whose `systemInstruction` starts on the given arm. */
function requestWith(systemInstruction: ContentUnion): LlmRequest {
  return {
    contents: [],
    toolsDict: {},
    liveConnectConfig: {},
    config: {systemInstruction},
  };
}

/** Reads back the instruction, failing the test if it is not a string. */
function systemInstructionOf(llmRequest: LlmRequest): string {
  const value = llmRequest.config?.systemInstruction;
  if (typeof value !== 'string') {
    expect.fail(`systemInstruction is ${typeof value}, expected a string`);
  }
  return value;
}

describe('appendInstructions', () => {
  it('creates the config when there is none', () => {
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    appendInstructions(llmRequest, ['NEW']);

    expect(llmRequest.config).toBeDefined();
    expect(systemInstructionOf(llmRequest)).toBe('NEW');
  });

  it('sets the instruction when the config has none', () => {
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {},
    };

    appendInstructions(llmRequest, ['NEW']);

    expect(systemInstructionOf(llmRequest)).toBe('NEW');
  });

  it('replaces an empty instruction without a leading separator', () => {
    const llmRequest = requestWith('');

    appendInstructions(llmRequest, ['NEW']);

    expect(systemInstructionOf(llmRequest)).toBe('NEW');
  });

  it('appends to a string instruction', () => {
    const llmRequest = requestWith('A');

    appendInstructions(llmRequest, ['NEW']);

    expect(systemInstructionOf(llmRequest)).toBe('A\n\nNEW');
  });

  it('keeps the text of a Content instruction', () => {
    const llmRequest = requestWith({role: 'system', parts: [{text: 'A'}]});

    appendInstructions(llmRequest, ['NEW']);

    expect(systemInstructionOf(llmRequest)).toBe('A\n\nNEW');
  });

  it('keeps the text of a bare Part instruction', () => {
    const llmRequest = requestWith({text: 'A'});

    appendInstructions(llmRequest, ['NEW']);

    expect(systemInstructionOf(llmRequest)).toBe('A\n\nNEW');
  });

  it('keeps the text of a Part array instruction', () => {
    const llmRequest = requestWith([{text: 'A'}, {text: 'B'}]);

    appendInstructions(llmRequest, ['NEW']);

    expect(systemInstructionOf(llmRequest)).toBe('A\nB\n\nNEW');
  });

  it('joins a string array instruction with newlines, not commas', () => {
    const llmRequest = requestWith(['G', 'A']);

    appendInstructions(llmRequest, ['NEW']);

    expect(systemInstructionOf(llmRequest)).toBe('G\nA\n\nNEW');
  });

  it('keeps the text of a mixed array instruction', () => {
    const llmRequest = requestWith(['G', {text: 'A'}]);

    appendInstructions(llmRequest, ['NEW']);

    expect(systemInstructionOf(llmRequest)).toBe('G\nA\n\nNEW');
  });

  it('replaces an empty array instruction without leading blank lines', () => {
    const llmRequest = requestWith([]);

    appendInstructions(llmRequest, ['NEW']);

    expect(systemInstructionOf(llmRequest)).toBe('NEW');
  });

  it('replaces a Content instruction that carries no text', () => {
    const llmRequest = requestWith({role: 'system', parts: [{}]});

    appendInstructions(llmRequest, ['NEW']);

    expect(systemInstructionOf(llmRequest)).toBe('NEW');
  });

  it('joins several instructions with a blank line', () => {
    const llmRequest = requestWith('A');

    appendInstructions(llmRequest, ['ONE', 'TWO']);

    expect(systemInstructionOf(llmRequest)).toBe('A\n\nONE\n\nTWO');
  });

  it('accumulates across successive calls', () => {
    const llmRequest = requestWith({role: 'system', parts: [{text: 'A'}]});

    appendInstructions(llmRequest, ['ONE']);
    appendInstructions(llmRequest, ['TWO']);

    expect(systemInstructionOf(llmRequest)).toBe('A\n\nONE\n\nTWO');
  });

  it('never writes the default object coercion into the instruction', () => {
    const arms: ContentUnion[] = [
      {role: 'system', parts: [{text: 'A'}]},
      {text: 'A'},
      [{text: 'A'}, {text: 'B'}],
      ['G', {text: 'A'}],
    ];

    for (const arm of arms) {
      const llmRequest = requestWith(arm);

      appendInstructions(llmRequest, ['NEW']);

      expect(systemInstructionOf(llmRequest)).not.toContain('[object Object]');
    }
  });
});
