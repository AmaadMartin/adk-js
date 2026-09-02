/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {appendInstructions, LlmRequest} from '../../src/models/llm_request.js';

function createRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

describe('appendInstructions', () => {
  describe('string array', () => {
    it('leaves the request untouched for an empty array', () => {
      const request = createRequest();

      appendInstructions(request, []);

      expect(request.config?.systemInstruction).toBeUndefined();
      expect(request.contents).toEqual([]);
    });

    it('sets the system instruction on the first append', () => {
      const request = createRequest();

      appendInstructions(request, ['First', 'Second']);

      expect(request.config?.systemInstruction).toBe('First\n\nSecond');
    });

    it('joins a later append onto the existing system instruction', () => {
      const request = createRequest();

      appendInstructions(request, ['First']);
      appendInstructions(request, ['Second']);

      expect(request.config?.systemInstruction).toBe('First\n\nSecond');
    });
  });

  describe('content', () => {
    it('joins the text parts into the system instruction', () => {
      const request = createRequest();

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
      const request = createRequest();

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
      const request = createRequest();

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
      const request = createRequest();

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
      const request = createRequest();

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
      const request = createRequest();

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
      const request = createRequest();

      appendInstructions(request, {
        role: 'user',
        parts: [{functionCall: {name: 'do_it'}}, {text: 'Only this'}],
      });

      expect(request.config?.systemInstruction).toBe('Only this');
      expect(request.contents).toEqual([]);
    });

    it('adds nothing for a content without parts', () => {
      const request = createRequest();

      appendInstructions(request, {role: 'user'});

      expect(request.config?.systemInstruction).toBeUndefined();
      expect(request.contents).toEqual([]);
    });
  });

  it('leaves a non-string system instruction untouched', () => {
    const request = createRequest();
    const existing: Content = {role: 'user', parts: [{text: 'Structured'}]};
    request.config = {systemInstruction: existing};

    appendInstructions(request, ['Appended']);

    expect(request.config.systemInstruction).toBe(existing);
  });

  it('rejects an argument that is neither a string array nor a content', () => {
    const request = createRequest();

    expect(() => appendInstructions(request, {})).toThrow(TypeError);
    expect(() => appendInstructions(request, {})).toThrow(
      'instructions must be string[] or Content, got object.',
    );
  });
});
