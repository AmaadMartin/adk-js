/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmRequest} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {
  appendInstructions,
  insertTransientUserContent,
} from '../../src/models/llm_request.js';
import {logger} from '../../src/utils/logger.js';

function createLlmRequest(contents: Content[] = []): LlmRequest {
  return {contents, toolsDict: {}, liveConnectConfig: {}};
}

function userText(text: string): Content {
  return {role: 'user', parts: [{text}]};
}

describe('appendInstructions with a string array', () => {
  it('joins the strings with a blank line', () => {
    const llmRequest = createLlmRequest();

    expect(appendInstructions(llmRequest, ['First', 'Second'])).toEqual([]);

    expect(llmRequest.config?.systemInstruction).toBe('First\n\nSecond');
  });

  it('appends to an existing system instruction with a blank line', () => {
    const llmRequest = createLlmRequest();
    llmRequest.config = {systemInstruction: 'Existing'};

    appendInstructions(llmRequest, ['Added']);

    expect(llmRequest.config.systemInstruction).toBe('Existing\n\nAdded');
  });

  it('leaves the system instruction unset for an empty array', () => {
    const llmRequest = createLlmRequest();

    expect(appendInstructions(llmRequest, [])).toEqual([]);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });

  it('warns and keeps a non-string system instruction untouched', () => {
    const llmRequest = createLlmRequest();
    const existing = userText('Already a Content');
    llmRequest.config = {systemInstruction: existing};
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    appendInstructions(llmRequest, ['Added']);

    expect(llmRequest.config.systemInstruction).toBe(existing);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain(
      'Cannot append to systemInstruction of unsupported type',
    );
    warn.mockRestore();
  });
});

describe('appendInstructions with a Content', () => {
  it('joins text parts into the system instruction and leaves contents alone', () => {
    const llmRequest = createLlmRequest();

    const userContents = appendInstructions(llmRequest, {
      role: 'user',
      parts: [{text: 'First part'}, {text: 'Second part'}],
    });

    expect(userContents).toEqual([]);
    expect(llmRequest.config?.systemInstruction).toBe(
      'First part\n\nSecond part',
    );
    expect(llmRequest.contents).toEqual([]);
    expect(llmRequest.hasStaticInstruction).toBeUndefined();
  });

  it('references inline data by display name and mime type', () => {
    const llmRequest = createLlmRequest();
    const inlineData = {
      data: 'Zm9v',
      mimeType: 'image/png',
      displayName: 'logo.png',
    };

    const userContents = appendInstructions(llmRequest, {
      role: 'user',
      parts: [{text: 'Look at this.'}, {inlineData}],
    });

    expect(llmRequest.config?.systemInstruction).toBe(
      'Look at this.\n\n[Reference to inline binary data: inline_data_0 ' +
        "('logo.png', type: image/png)]",
    );
    expect(userContents).toEqual([
      {
        role: 'user',
        parts: [{text: 'Referenced inline data: inline_data_0'}, {inlineData}],
      },
    ]);
    expect(llmRequest.contents).toEqual(userContents);
    expect(llmRequest.hasStaticInstruction).toBe(true);
  });

  it('omits the name segment when inline data has no display name', () => {
    const llmRequest = createLlmRequest();

    appendInstructions(llmRequest, {
      role: 'user',
      parts: [{inlineData: {data: 'Zm9v', mimeType: 'image/png'}}],
    });

    expect(llmRequest.config?.systemInstruction).toBe(
      '[Reference to inline binary data: inline_data_0 (type: image/png)]',
    );
  });

  it('omits the descriptor entirely when inline data carries no metadata', () => {
    const llmRequest = createLlmRequest();

    appendInstructions(llmRequest, {
      role: 'user',
      parts: [{inlineData: {data: 'Zm9v'}}],
    });

    expect(llmRequest.config?.systemInstruction).toBe(
      '[Reference to inline binary data: inline_data_0]',
    );
  });

  it('references file data by display name, URI and mime type in that order', () => {
    const llmRequest = createLlmRequest();
    const fileData = {
      fileUri: 'files/handbook',
      mimeType: 'application/pdf',
      displayName: 'handbook.pdf',
    };

    const userContents = appendInstructions(llmRequest, {
      role: 'user',
      parts: [{text: 'Answer only from the handbook below.'}, {fileData}],
    });

    expect(llmRequest.config?.systemInstruction).toBe(
      'Answer only from the handbook below.\n\n[Reference to file data: ' +
        "file_data_0 ('handbook.pdf', URI: files/handbook, " +
        'type: application/pdf)]',
    );
    expect(userContents).toEqual([
      {
        role: 'user',
        parts: [{text: 'Referenced file data: file_data_0'}, {fileData}],
      },
    ]);
  });

  it('omits the descriptor entirely when file data carries no metadata', () => {
    const llmRequest = createLlmRequest();

    appendInstructions(llmRequest, {role: 'user', parts: [{fileData: {}}]});

    expect(llmRequest.config?.systemInstruction).toBe(
      '[Reference to file data: file_data_0]',
    );
  });

  it('numbers reference ids from one counter shared by both kinds', () => {
    const llmRequest = createLlmRequest();

    appendInstructions(llmRequest, {
      role: 'user',
      parts: [
        {inlineData: {data: 'YQ==', mimeType: 'image/png'}},
        {fileData: {fileUri: 'files/b', mimeType: 'application/pdf'}},
        {inlineData: {data: 'Yw==', mimeType: 'image/jpeg'}},
      ],
    });

    expect(llmRequest.config?.systemInstruction).toBe(
      '[Reference to inline binary data: inline_data_0 (type: image/png)]\n\n' +
        '[Reference to file data: file_data_1 (URI: files/b, ' +
        'type: application/pdf)]\n\n' +
        '[Reference to inline binary data: inline_data_2 (type: image/jpeg)]',
    );
    expect(llmRequest.contents).toHaveLength(3);
  });

  it('skips a part that is neither text nor data', () => {
    const llmRequest = createLlmRequest();

    const userContents = appendInstructions(llmRequest, {
      role: 'user',
      parts: [{functionCall: {name: 'lookup'}}, {text: 'Kept'}],
    });

    expect(llmRequest.config?.systemInstruction).toBe('Kept');
    expect(userContents).toEqual([]);
  });

  it('treats a Content without parts as empty', () => {
    const llmRequest = createLlmRequest();

    expect(appendInstructions(llmRequest, {role: 'user'})).toEqual([]);

    expect(llmRequest.config?.systemInstruction).toBeUndefined();
  });
});

describe('insertTransientUserContent', () => {
  it('does nothing for an empty list', () => {
    const llmRequest = createLlmRequest([userText('Hi')]);

    insertTransientUserContent(llmRequest, []);

    expect(llmRequest.contents).toEqual([userText('Hi')]);
  });

  it('puts non-text static-instruction content at the front', () => {
    const llmRequest = createLlmRequest([userText('Hi')]);
    llmRequest.hasStaticInstruction = true;

    insertTransientUserContent(llmRequest, [userText('Referenced file data')]);

    expect(llmRequest.contents).toEqual([
      userText('Referenced file data'),
      userText('Hi'),
    ]);
  });

  it('inserts before the trailing run of user content', () => {
    const llmRequest = createLlmRequest([
      userText('Older question'),
      {role: 'model', parts: [{text: 'Older answer'}]},
      userText('New question'),
      userText('One more thing'),
    ]);

    insertTransientUserContent(llmRequest, [userText('Instruction')]);

    expect(llmRequest.contents.map((c) => c.parts?.[0].text)).toEqual([
      'Older question',
      'Older answer',
      'Instruction',
      'New question',
      'One more thing',
    ]);
  });

  it('inserts after a trailing function response', () => {
    const llmRequest = createLlmRequest([
      userText('Question'),
      {role: 'model', parts: [{functionCall: {name: 'lookup'}}]},
      {
        role: 'user',
        parts: [{functionResponse: {name: 'lookup', response: {out: 1}}}],
      },
    ]);

    insertTransientUserContent(llmRequest, [userText('Instruction')]);

    expect(llmRequest.contents[3]).toEqual(userText('Instruction'));
  });

  it('appends when every content is user content', () => {
    const llmRequest = createLlmRequest([]);

    insertTransientUserContent(llmRequest, [userText('Instruction')]);

    expect(llmRequest.contents).toEqual([userText('Instruction')]);
  });
});
