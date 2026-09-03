/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  BaseToolset,
  Context,
  FunctionTool,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  ReadonlyContext,
} from '@google/adk';
import {Content, Schema, Type} from '@google/genai';
import {z} from 'zod';

/** The value read when a qualified name carries no export. */
export default 'the default export';

/** A model that answers with one fixed text, so a run needs no network. */
export class ScriptedLlm extends BaseLlm {
  readonly seen: LlmRequest[] = [];

  constructor(readonly text: string) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.seen.push(request);
    yield {content: {role: 'model', parts: [{text: this.text}]}};
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('The scripted model does not support a live connection.');
  }
}

/** A pre-configured model, the case `model_code` exists for. */
export const preconfiguredModel = new ScriptedLlm('a scripted reply');

/** A tool a config document can name directly. */
export const searchTool = new FunctionTool({
  name: 'search',
  description: 'Searches a corpus.',
  execute: () => ({results: ['a result']}),
});

/** Records the args each factory call received. */
export const factoryArgs: Array<{corpus_id?: string}> = [];

/** A factory, the case tool `args` exist for. */
export function createRetriever(args: {corpus_id?: string}): FunctionTool {
  factoryArgs.push(args);
  const corpusId = args.corpus_id ?? 'default-corpus';
  return new FunctionTool({
    name: `retrieve_${corpusId}`,
    description: 'Retrieves documents.',
    execute: () => ({corpusId}),
  });
}

/** An async factory, to prove the resolver awaits the result. */
export async function createRetrieverAsync(args: {
  corpus_id?: string;
}): Promise<FunctionTool> {
  return createRetriever(args);
}

class SingleToolset extends BaseToolset {
  constructor() {
    super([]);
  }

  async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    return [searchTool];
  }

  async close(): Promise<void> {}
}

/** A toolset a config document can name directly. */
export const searchToolset = new SingleToolset();

/** A factory that returns something that is not a tool. */
export function createNothing(): string {
  return 'not a tool';
}

/** A class, which throws a TypeError when called without `new`. */
export class NotAFactory {
  readonly built = true;
}

/** Records the order the resolved callbacks run in. */
export const callOrder: string[] = [];

export function firstCallback(_params: {
  context: Context;
  request: LlmRequest;
}): undefined {
  callOrder.push('first');
  return undefined;
}

export function secondCallback(_params: {
  context: Context;
  request: LlmRequest;
}): undefined {
  callOrder.push('second');
  return undefined;
}

export function beforeAgentCallback(_context: Context): Content | undefined {
  callOrder.push('before agent');
  return undefined;
}

/** A Zod schema, the shape `input_schema` and `output_schema` usually name. */
export const answerSchema = z.object({answer: z.string()});

/** A `@google/genai` schema, the other shape they accept. */
export const genaiAnswerSchema: Schema = {
  type: Type.OBJECT,
  properties: {answer: {type: Type.STRING}},
};

/** An agent a `sub_agents` entry can name with `code`. */
export const helperAgent = new LlmAgent({
  name: 'helper_agent',
  description: 'A sub-agent named by a config document.',
  instruction: 'Help.',
});

/** A value that is none of the kinds a reference may resolve to. */
export const notAnything = 42;
