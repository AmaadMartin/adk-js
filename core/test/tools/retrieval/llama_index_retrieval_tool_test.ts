/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  LlamaIndexNode,
  LlamaIndexRetrievalTool,
  LlamaIndexRetriever,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** Stands in for a LlamaIndex.TS node, which exposes its text by method. */
function fakeNode(text: string): LlamaIndexNode {
  return {getContent: () => text};
}

/** Records the query it was asked for and replays canned nodes. */
class FakeRetriever implements LlamaIndexRetriever {
  receivedQuery: string | undefined;
  callCount = 0;

  constructor(private readonly nodes: LlamaIndexNode[]) {}

  async retrieve(query: string): Promise<Array<{node: LlamaIndexNode}>> {
    this.callCount++;
    this.receivedQuery = query;
    return this.nodes.map((node) => ({node}));
  }
}

function makeTool(retriever: LlamaIndexRetriever): LlamaIndexRetrievalTool {
  return new LlamaIndexRetrievalTool({
    name: 'docs',
    description: 'Retrieves documentation.',
    retriever,
  });
}

// The tool never reads the context, so an empty stand-in is enough.
const TOOL_CONTEXT = {} as Context;

describe('LlamaIndexRetrievalTool', () => {
  it('returns the text of the top result', async () => {
    const retriever = new FakeRetriever([
      fakeNode('best match'),
      fakeNode('worse match'),
    ]);

    const result = await makeTool(retriever).runAsync({
      args: {query: 'anything'},
      toolContext: TOOL_CONTEXT,
    });

    expect(result).toBe('best match');
  });

  it('asks the node for its text without any metadata', async () => {
    let receivedMode: string | undefined;
    const node: LlamaIndexNode = {
      getContent: (metadataMode) => {
        receivedMode = metadataMode;
        return 'a document';
      },
    };
    const retriever: LlamaIndexRetriever = {
      retrieve: async () => [{node}],
    };

    await makeTool(retriever).runAsync({
      args: {query: 'anything'},
      toolContext: TOOL_CONTEXT,
    });

    expect(receivedMode).toBe('NONE');
  });

  it('reports no match when the retriever returns nothing', async () => {
    const retriever = new FakeRetriever([]);

    const result = await makeTool(retriever).runAsync({
      args: {query: 'nothing matches this'},
      toolContext: TOOL_CONTEXT,
    });

    expect(result).toBe(
      'No matching result found for the query: nothing matches this',
    );
  });

  it('passes the query string, not the whole args object', async () => {
    const retriever = new FakeRetriever([fakeNode('a document')]);

    await makeTool(retriever).runAsync({
      args: {query: 'how do i retrieve', unused: 1},
      toolContext: TOOL_CONTEXT,
    });

    expect(retriever.receivedQuery).toBe('how do i retrieve');
  });

  it('forwards an empty query to the retriever', async () => {
    const retriever = new FakeRetriever([fakeNode('a document')]);

    await makeTool(retriever).runAsync({
      args: {query: ''},
      toolContext: TOOL_CONTEXT,
    });

    expect(retriever.receivedQuery).toBe('');
  });

  it('forwards the name and the description to the declaration', () => {
    const declaration = makeTool(new FakeRetriever([]))._getDeclaration();

    expect(declaration.name).toBe('docs');
    expect(declaration.description).toBe('Retrieves documentation.');
  });

  it('lets an error from the retriever propagate unchanged', async () => {
    const failure = new Error('index unavailable');
    const retriever: LlamaIndexRetriever = {
      retrieve: () => Promise.reject(failure),
    };

    await expect(
      makeTool(retriever).runAsync({
        args: {query: 'anything'},
        toolContext: TOOL_CONTEXT,
      }),
    ).rejects.toBe(failure);
  });

  // LlamaIndex.TS declares `retrieve(params: QueryType)`, `QueryType = string |
  // QueryBundle`, `NodeWithScore = {node: BaseNode; score?: number}` and
  // `abstract getContent(metadataMode: MetadataMode): string`. This replica
  // keeps those signatures, so `npm run ts:check` fails if the tool's
  // interfaces ever stop accepting a real retriever without a cast.
  it('accepts a retriever with the LlamaIndex.TS signatures, uncast', async () => {
    enum MetadataMode {
      ALL = 'ALL',
      NONE = 'NONE',
    }
    type QueryBundle = {query: string};
    abstract class BaseNode {
      abstract getContent(metadataMode: MetadataMode): string;
    }
    class TextNode extends BaseNode {
      constructor(private readonly text: string) {
        super();
      }
      override getContent(metadataMode: MetadataMode) {
        return metadataMode === MetadataMode.NONE
          ? this.text
          : `meta ${this.text}`;
      }
    }
    class BaseRetriever {
      async retrieve(
        params: string | QueryBundle,
      ): Promise<Array<{node: BaseNode; score?: number}>> {
        const query = typeof params === 'string' ? params : params.query;
        return [{node: new TextNode(`hit for ${query}`), score: 0.9}];
      }
    }

    const retriever: LlamaIndexRetriever = new BaseRetriever();

    const result = await makeTool(retriever).runAsync({
      args: {query: 'grounding'},
      toolContext: TOOL_CONTEXT,
    });

    expect(result).toBe('hit for grounding');
  });

  it.each([
    ['a missing query', {}],
    ['a numeric query', {query: 42}],
    ['a null query', {query: null}],
  ])('rejects %s without calling the retriever', async (_name, args) => {
    const retriever = new FakeRetriever([fakeNode('a document')]);

    await expect(
      makeTool(retriever).runAsync({args, toolContext: TOOL_CONTEXT}),
    ).rejects.toThrow("Tool docs requires a string 'query' argument.");
    expect(retriever.callCount).toBe(0);
  });
});
