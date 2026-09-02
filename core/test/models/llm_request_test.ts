/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content, ContentUnion} from '@google/genai';
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

/** Builds a request that carries no config at all. */
function createRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
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

  it('flattens a Content system instruction before a Content instruction', () => {
    const llmRequest = requestWith({role: 'system', parts: [{text: 'A'}]});

    appendInstructions(llmRequest, {role: 'user', parts: [{text: 'Static'}]});

    expect(systemInstructionOf(llmRequest)).toBe('A\n\nStatic');
  });

  describe('list of strings', () => {
    it('joins the instructions with a blank line', () => {
      const llmRequest = createRequest();

      appendInstructions(llmRequest, [
        'First instruction',
        'Second instruction',
      ]);

      expect(llmRequest.config?.systemInstruction).toBe(
        'First instruction\n\nSecond instruction',
      );
      expect(llmRequest.contents).toEqual([]);
    });

    it('appends to an existing system instruction with a blank line', () => {
      const llmRequest = createRequest();
      llmRequest.config = {systemInstruction: 'Existing'};

      appendInstructions(llmRequest, ['Added']);

      expect(llmRequest.config.systemInstruction).toBe('Existing\n\nAdded');
    });

    it('leaves the request untouched for an empty list', () => {
      const llmRequest = createRequest();

      appendInstructions(llmRequest, []);

      expect(llmRequest.config?.systemInstruction).toBeUndefined();
      expect(llmRequest.contents).toEqual([]);
    });
  });

  describe('content', () => {
    it('joins text parts and extracts no user content', () => {
      const llmRequest = createRequest();
      const content: Content = {
        role: 'user',
        parts: [{text: 'First part'}, {text: 'Second part'}],
      };

      appendInstructions(llmRequest, content);

      expect(llmRequest.config?.systemInstruction).toBe(
        'First part\n\nSecond part',
      );
      expect(llmRequest.contents).toEqual([]);
    });

    it('treats a content with no parts as a no-op', () => {
      const llmRequest = createRequest();

      appendInstructions(llmRequest, {role: 'user'});

      expect(llmRequest.config?.systemInstruction).toBeUndefined();
      expect(llmRequest.contents).toEqual([]);
    });

    it('ignores a part that is neither text nor data', () => {
      const llmRequest = createRequest();
      const content: Content = {
        role: 'user',
        parts: [{text: 'Kept'}, {thought: true}],
      };

      appendInstructions(llmRequest, content);

      expect(llmRequest.config?.systemInstruction).toBe('Kept');
      expect(llmRequest.contents).toEqual([]);
    });

    it('references inline data by mime type when it has no display name', () => {
      const llmRequest = createRequest();
      const content: Content = {
        role: 'user',
        parts: [
          {text: 'Look at this'},
          {inlineData: {data: 'abc123', mimeType: 'image/png'}},
        ],
      };

      appendInstructions(llmRequest, content);

      expect(llmRequest.config?.systemInstruction).toBe(
        'Look at this\n\n[Reference to inline binary data: inline_data_0 (type: image/png)]',
      );
      expect(llmRequest.contents).toEqual([
        {
          role: 'user',
          parts: [
            {text: 'Referenced inline data: inline_data_0'},
            {inlineData: {data: 'abc123', mimeType: 'image/png'}},
          ],
        },
      ]);
    });

    it('references inline data by display name and mime type', () => {
      const llmRequest = createRequest();
      const content: Content = {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: 'abc123',
              mimeType: 'image/png',
              displayName: 'test_image.png',
            },
          },
        ],
      };

      appendInstructions(llmRequest, content);

      expect(llmRequest.config?.systemInstruction).toBe(
        "[Reference to inline binary data: inline_data_0 ('test_image.png', type: image/png)]",
      );
    });

    it('references inline data without descriptors when it has neither', () => {
      const llmRequest = createRequest();
      const content: Content = {
        role: 'user',
        parts: [{inlineData: {data: 'abc123'}}],
      };

      appendInstructions(llmRequest, content);

      expect(llmRequest.config?.systemInstruction).toBe(
        '[Reference to inline binary data: inline_data_0]',
      );
    });

    it('references file data by display name, uri and mime type', () => {
      const llmRequest = createRequest();
      const content: Content = {
        role: 'user',
        parts: [
          {
            fileData: {
              fileUri: 'files/test123',
              mimeType: 'text/plain',
              displayName: 'test_file.txt',
            },
          },
        ],
      };

      appendInstructions(llmRequest, content);

      expect(llmRequest.config?.systemInstruction).toBe(
        "[Reference to file data: file_data_0 ('test_file.txt', URI: files/test123, type: text/plain)]",
      );
      expect(llmRequest.contents).toEqual([
        {
          role: 'user',
          parts: [
            {text: 'Referenced file data: file_data_0'},
            {
              fileData: {
                fileUri: 'files/test123',
                mimeType: 'text/plain',
                displayName: 'test_file.txt',
              },
            },
          ],
        },
      ]);
    });

    it('references file data without descriptors when it has none', () => {
      const llmRequest = createRequest();

      appendInstructions(llmRequest, {role: 'user', parts: [{fileData: {}}]});

      expect(llmRequest.config?.systemInstruction).toBe(
        '[Reference to file data: file_data_0]',
      );
    });

    it('numbers inline and file references from one shared counter', () => {
      const llmRequest = createRequest();
      const content: Content = {
        role: 'user',
        parts: [
          {inlineData: {data: 'a', mimeType: 'image/png'}},
          {fileData: {fileUri: 'files/b', mimeType: 'text/plain'}},
          {inlineData: {data: 'c', mimeType: 'image/jpeg'}},
        ],
      };

      appendInstructions(llmRequest, content);

      expect(llmRequest.config?.systemInstruction).toBe(
        '[Reference to inline binary data: inline_data_0 (type: image/png)]\n\n' +
          '[Reference to file data: file_data_1 (URI: files/b, type: text/plain)]\n\n' +
          '[Reference to inline binary data: inline_data_2 (type: image/jpeg)]',
      );
      expect(llmRequest.contents).toHaveLength(3);
      for (const userContent of llmRequest.contents) {
        expect(userContent.parts).toHaveLength(2);
      }
    });

    it('appends the extracted content to the request', () => {
      const llmRequest = createRequest();
      const content: Content = {
        role: 'user',
        parts: [{fileData: {fileUri: 'files/test123'}}],
      };

      appendInstructions(llmRequest, content);

      expect(llmRequest.contents).toEqual([
        {
          role: 'user',
          parts: [
            {text: 'Referenced file data: file_data_0'},
            {fileData: {fileUri: 'files/test123'}},
          ],
        },
      ]);
    });

    it('appends its text after an existing system instruction', () => {
      const llmRequest = createRequest();
      llmRequest.config = {systemInstruction: 'Global'};

      appendInstructions(llmRequest, {role: 'user', parts: [{text: 'Static'}]});

      expect(llmRequest.config.systemInstruction).toBe('Global\n\nStatic');
    });

    it('keeps conversation history ahead of the extracted user content', () => {
      const llmRequest = createRequest();
      llmRequest.contents = [{role: 'user', parts: [{text: 'Earlier turn'}]}];

      appendInstructions(llmRequest, {
        role: 'user',
        parts: [{fileData: {fileUri: 'files/test123'}}],
      });

      expect(llmRequest.contents).toHaveLength(2);
      expect(llmRequest.contents[0].parts?.[0].text).toBe('Earlier turn');
    });
  });
});
