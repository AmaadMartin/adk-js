/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  InMemorySessionService,
  ListRagFilesParams,
  ListRagFilesResponse,
  LlmAgent,
  LOAD_MEMORY,
  RagApiClient,
  RetrieveContextsParams,
  RetrieveContextsResponse,
  Runner,
  UploadRagFileParams,
  VertexAiRagMemoryService,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {GeminiWithMockResponses} from '../test_case_utils.js';

const APP_NAME = 'test_rag_memory_app';
const CORPUS = 'projects/test-project/locations/us-central1/ragCorpora/1';

/**
 * A RAG corpus held in this process: uploads land in a list, listings page
 * over it, and a retrieval returns the files whose transcript contains a word
 * of the query. Enough to exercise the real add-then-search path with no
 * network.
 */
class InProcessRagCorpus implements RagApiClient {
  private readonly files: Array<{
    name: string;
    displayName: string;
    content: string;
  }> = [];

  async uploadRagFile(params: UploadRagFileParams): Promise<void> {
    this.files.push({
      name: `${params.ragCorpus}/ragFiles/file-${this.files.length + 1}`,
      displayName: params.displayName,
      content: params.content,
    });
  }

  async listRagFiles(
    params: ListRagFilesParams,
  ): Promise<ListRagFilesResponse> {
    const start = params.pageToken ? Number(params.pageToken) : 0;
    const end = start + params.pageSize;
    return {
      ragFiles: this.files
        .slice(start, end)
        .map(({name, displayName}) => ({name, displayName})),
      nextPageToken: end < this.files.length ? String(end) : undefined,
    };
  }

  async retrieveContexts(
    params: RetrieveContextsParams,
  ): Promise<RetrieveContextsResponse> {
    const ragFileIds = params.vertexRagStore.ragResources?.[0].ragFileIds;
    const words = params.query.text.toLowerCase().split(/\s+/);
    const contexts = this.files
      .filter(
        (file) =>
          !ragFileIds || ragFileIds.includes(file.name.split('/').pop() ?? ''),
      )
      .filter((file) =>
        words.some((word) => file.content.toLowerCase().includes(word)),
      )
      .map((file) => ({
        sourceDisplayName: file.displayName,
        text: file.content,
      }));
    return {contexts: {contexts}};
  }
}

function createRunner(memoryService: VertexAiRagMemoryService): Runner {
  const agent = new LlmAgent({
    name: 'memory_agent',
    description: 'Answers questions from memory.',
    instruction: 'Answer questions about the user using memory.',
    tools: [LOAD_MEMORY],
  });
  agent.model = new GeminiWithMockResponses([
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'load_memory',
                  args: {query: 'favorite color'},
                },
              },
            ],
          },
        },
      ],
    },
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{text: 'Your favorite color is green.'}],
          },
        },
      ],
    },
  ]);

  return new Runner({
    appName: APP_NAME,
    agent,
    sessionService: new InMemorySessionService(),
    memoryService,
  });
}

/** Stores one finished conversation for `userId`. */
async function rememberConversation(
  runner: Runner,
  userId: string,
  text: string,
): Promise<void> {
  const session = await runner.sessionService.createSession({
    appName: APP_NAME,
    userId,
  });
  await runner.sessionService.appendEvent({
    session,
    event: createEvent({author: 'user', content: createUserContent(text)}),
  });
  await runner.memoryService!.addSessionToMemory(session);
}

describe('VertexAiRagMemoryService Integration', () => {
  it('recalls a stored session through the LOAD_MEMORY tool', async () => {
    const memoryService = new VertexAiRagMemoryService({
      ragCorpus: CORPUS,
      ragApiClient: new InProcessRagCorpus(),
    });
    const runner = createRunner(memoryService);
    await rememberConversation(
      runner,
      'test_user',
      'My favorite color is green.',
    );

    const session = await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: 'test_user',
    });
    let finalResponse = '';
    let memoryLoaded = false;
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('What is my favorite color?'),
    })) {
      if (event.author === 'memory_agent') {
        finalResponse += event.content?.parts?.[0]?.text ?? '';
      }
      if (event.content?.parts?.[0]?.functionResponse?.name === 'load_memory') {
        memoryLoaded = true;
      }
    }

    expect(memoryLoaded).toBe(true);
    expect(finalResponse).toContain('Your favorite color is green.');
  });

  it('does not return another user memory from the same corpus', async () => {
    const corpus = new InProcessRagCorpus();
    const memoryService = new VertexAiRagMemoryService({
      ragCorpus: CORPUS,
      ragApiClient: corpus,
    });
    const runner = createRunner(memoryService);
    await rememberConversation(runner, 'alice', 'My favorite color is green.');
    await rememberConversation(runner, 'bob', 'My favorite color is red.');

    const alice = await memoryService.searchMemory({
      appName: APP_NAME,
      userId: 'alice',
      query: 'favorite color',
    });
    const carol = await memoryService.searchMemory({
      appName: APP_NAME,
      userId: 'carol',
      query: 'favorite color',
    });

    expect(
      alice.memories.map((memory) => memory.content.parts?.[0].text),
    ).toEqual(['My favorite color is green.']);
    expect(carol.memories).toEqual([]);
  });
});
