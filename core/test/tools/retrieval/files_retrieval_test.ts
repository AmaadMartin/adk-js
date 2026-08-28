/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, EmbeddingModel, FilesRetrieval} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {getDefaultEmbeddingModel} = vi.hoisted(() => ({
  getDefaultEmbeddingModel: vi.fn<() => EmbeddingModel>(),
}));

vi.mock(
  '@google/adk/tools/retrieval/embedding_model.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@google/adk/tools/retrieval/embedding_model.js')
    >()),
    getDefaultEmbeddingModel,
  }),
);

/** The words the fake embedding model scores, one dimension each. */
const VOCABULARY = ['loop', 'sequential', 'artifact'];

/**
 * Embeds text as counts of the words in `VOCABULARY`.
 *
 * The vectors are deterministic and need no credentials, which is what lets
 * the whole tool run end to end in a unit test.
 */
class BagOfWordsEmbeddingModel implements EmbeddingModel {
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((text) => embed(text));
  }

  async embedQuery(text: string): Promise<number[]> {
    return embed(text);
  }
}

function embed(text: string): number[] {
  const words = text.toLowerCase().split(/\W+/);
  return VOCABULARY.map((term) => words.filter((word) => word === term).length);
}

/** `runAsync` never touches the context, so an empty stand-in is enough. */
function makeToolContext(): Context {
  return {} as Context;
}

let inputDir: string;

beforeEach(async () => {
  getDefaultEmbeddingModel.mockReset();
  getDefaultEmbeddingModel.mockImplementation(
    () => new BagOfWordsEmbeddingModel(),
  );
  inputDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'adk-files-retrieval-test-'),
  );
});

afterEach(async () => {
  await fs.rm(inputDir, {recursive: true, force: true});
});

async function writeFile(name: string, contents: string): Promise<void> {
  await fs.writeFile(path.join(inputDir, name), contents);
}

function create(embeddingModel?: EmbeddingModel): Promise<FilesRetrieval> {
  return FilesRetrieval.create({
    name: 'search_documents',
    description: 'Search the local documents.',
    inputDir,
    embeddingModel,
  });
}

describe('FilesRetrieval.create', () => {
  it('keeps the name and the input directory it was given', async () => {
    await writeFile('agents.txt', 'ADK supports the loop agent.');

    const tool = await create(new BagOfWordsEmbeddingModel());

    expect(tool.name).toBe('search_documents');
    expect(tool.description).toBe('Search the local documents.');
    expect(tool.inputDir).toBe(inputDir);
  });

  it('answers with the text of the file that matches the query', async () => {
    await writeFile('loops.txt', 'The loop agent repeats its sub-agents.');
    await writeFile('artifacts.txt', 'An artifact holds binary output.');

    const tool = await create(new BagOfWordsEmbeddingModel());
    const result = await tool.runAsync({
      args: {query: 'how does the loop agent work'},
      toolContext: makeToolContext(),
    });

    expect(result).toBe('The loop agent repeats its sub-agents.');
  });

  it('answers with a string when nothing in the index matches', async () => {
    await writeFile('loops.txt', 'The loop agent repeats its sub-agents.');

    const tool = await create(new BagOfWordsEmbeddingModel());
    const result = await tool.runAsync({
      args: {query: 'a query with no indexed word in it'},
      toolContext: makeToolContext(),
    });

    // Every score is 0, so the retriever still ranks and returns a document.
    expect(typeof result).toBe('string');
  });

  it('falls back to the default embedding model', async () => {
    await writeFile('agents.txt', 'ADK supports the loop agent.');

    await create();

    expect(getDefaultEmbeddingModel).toHaveBeenCalledTimes(1);
  });

  it('does not build the default model when one is given', async () => {
    await writeFile('agents.txt', 'ADK supports the loop agent.');

    await create(new BagOfWordsEmbeddingModel());

    expect(getDefaultEmbeddingModel).not.toHaveBeenCalled();
  });

  it('rejects a directory that does not exist', async () => {
    const missing = path.join(inputDir, 'missing');

    await expect(
      FilesRetrieval.create({
        name: 'search_documents',
        description: 'Search the local documents.',
        inputDir: missing,
        embeddingModel: new BagOfWordsEmbeddingModel(),
      }),
    ).rejects.toThrow(`Input directory does not exist: ${missing}`);
  });

  it('rejects a directory that holds no text to index', async () => {
    await expect(create(new BagOfWordsEmbeddingModel())).rejects.toThrow(
      `No files found in: ${inputDir}`,
    );
  });

  it('reads the files once, however many queries follow', async () => {
    await writeFile('loops.txt', 'The loop agent repeats its sub-agents.');
    const embeddingModel = new BagOfWordsEmbeddingModel();
    const embedDocuments = vi.spyOn(embeddingModel, 'embedDocuments');

    const tool = await create(embeddingModel);
    await tool.runAsync({
      args: {query: 'loop'},
      toolContext: makeToolContext(),
    });
    await tool.runAsync({
      args: {query: 'loop'},
      toolContext: makeToolContext(),
    });

    expect(embedDocuments).toHaveBeenCalledTimes(1);
  });
});
