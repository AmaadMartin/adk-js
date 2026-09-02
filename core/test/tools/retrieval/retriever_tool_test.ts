/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  RetrievedDocument,
  Retriever,
  RetrieverTool,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

/** `runAsync` never touches the context, so an empty stand-in is enough. */
function makeToolContext(): Context {
  return {} as Context;
}

/** A retriever that answers with a fixed list and records every query. */
class FakeRetriever implements Retriever {
  readonly queries: string[] = [];

  constructor(private readonly documents: RetrievedDocument[]) {}

  async retrieve(query: string): Promise<RetrievedDocument[]> {
    this.queries.push(query);
    return this.documents;
  }
}

function makeTool(documents: RetrievedDocument[]): {
  tool: RetrieverTool;
  retriever: FakeRetriever;
} {
  const retriever = new FakeRetriever(documents);
  const tool = new RetrieverTool({
    name: 'test_retrieval',
    description: 'A test retrieval tool.',
    retriever,
  });
  return {tool, retriever};
}

describe('RetrieverTool', () => {
  it('returns the text of the top-ranked document only', async () => {
    const {tool} = makeTool([
      {text: 'The best match.', score: 0.9},
      {text: 'A weaker match.', score: 0.4},
    ]);

    const result = await tool.runAsync({
      args: {query: 'how do i retrieve'},
      toolContext: makeToolContext(),
    });

    expect(result).toBe('The best match.');
  });

  it('reports no match instead of failing when nothing is found', async () => {
    const {tool} = makeTool([]);

    const result = await tool.runAsync({
      args: {query: 'nothing matches this'},
      toolContext: makeToolContext(),
    });

    expect(result).toBe(
      'No matching result found for the query: nothing matches this',
    );
  });

  it('passes the query string to the retriever, not the whole args', async () => {
    const {tool, retriever} = makeTool([{text: 'A match.'}]);

    await tool.runAsync({
      args: {query: 'how do i retrieve', unused: 1},
      toolContext: makeToolContext(),
    });

    expect(retriever.queries).toEqual(['how do i retrieve']);
  });

  it('forwards the name and the description to the declaration', () => {
    const {tool} = makeTool([]);

    const declaration = tool._getDeclaration();

    expect(declaration).toEqual({
      name: 'test_retrieval',
      description: 'A test retrieval tool.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: 'The query to retrieve.',
          },
        },
      },
    });
  });

  it.each([
    ['a missing query', {}],
    ['a number', {query: 42}],
    ['blank text', {query: '  '}],
  ])('rejects %s from the model', async (_name, args) => {
    const {tool, retriever} = makeTool([{text: 'A match.'}]);

    await expect(
      tool.runAsync({args, toolContext: makeToolContext()}),
    ).rejects.toThrow(
      'Retrieval requires a non-empty string "query" argument.',
    );
    expect(retriever.queries).toEqual([]);
  });
});
