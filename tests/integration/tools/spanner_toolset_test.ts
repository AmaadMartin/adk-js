/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  SpannerCredentialsConfig,
  SpannerToolset,
  SpannerToolSettings,
  SpannerVectorStoreSettings,
} from '@google/adk';
import {FunctionDeclaration} from '@google/genai';
import {describe, expect, it} from 'vitest';

/**
 * Drives the toolset the way an `LlmAgent` turn does, and returns the
 * function declarations that reach the request the model receives.
 */
async function declarationsFor(
  toolset: SpannerToolset,
): Promise<FunctionDeclaration[]> {
  const agent = new LlmAgent({
    name: 'spanner_agent',
    model: 'gemini-2.5-flash',
    tools: [toolset],
  });
  const toolContext = new Context({
    invocationContext: new InvocationContext({
      invocationId: 'spanner-integration',
      agent,
      session: createSession({id: 'session', appName: 'spanner-integration'}),
      pluginManager: new PluginManager(),
    }),
  });
  const llmRequest: LlmRequest = {
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
  };
  for (const tool of await agent.canonicalTools()) {
    await tool.processLlmRequest({toolContext, llmRequest});
  }
  return (llmRequest.config?.tools ?? []).flatMap(
    (tool) =>
      ('functionDeclarations' in tool && tool.functionDeclarations) || [],
  );
}

describe('SpannerToolset in an LlmAgent', () => {
  it('declares every tool under the spanner prefix', async () => {
    const declarations = await declarationsFor(new SpannerToolset());

    expect(declarations.map((declaration) => declaration.name)).toEqual([
      'spanner_list_table_names',
      'spanner_list_table_indexes',
      'spanner_list_table_index_columns',
      'spanner_list_named_schemas',
      'spanner_get_table_schema',
      'spanner_execute_sql',
      'spanner_similarity_search',
    ]);
  });

  it('declares snake_case parameters and hides the injected ones', async () => {
    const declarations = await declarationsFor(
      new SpannerToolset({
        credentialsConfig: new SpannerCredentialsConfig({
          clientId: 'client-id',
          clientSecret: 'client-secret',
        }),
      }),
    );

    for (const declaration of declarations) {
      const properties = Object.keys(declaration.parameters?.properties ?? {});
      expect(properties).not.toContain('credentials');
      expect(properties).not.toContain('settings');
      for (const property of properties) {
        expect(property).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('declares the database parameters the model has to fill in', async () => {
    const declarations = await declarationsFor(new SpannerToolset());
    const executeSql = declarations.find(
      (declaration) => declaration.name === 'spanner_execute_sql',
    );

    expect(executeSql?.parameters?.required).toEqual([
      'project_id',
      'instance_id',
      'database_id',
      'query',
    ]);
  });

  it('declares the vector store tool when one is configured', async () => {
    const declarations = await declarationsFor(
      new SpannerToolset({
        spannerToolSettings: new SpannerToolSettings({
          vectorStoreSettings: new SpannerVectorStoreSettings({
            projectId: 'my-project',
            instanceId: 'my-instance',
            databaseId: 'my-database',
            tableName: 'documents',
            contentColumn: 'content',
            embeddingColumn: 'embedding',
            vectorLength: 768,
            vertexAiEmbeddingModelName: 'text-embedding-005',
          }),
        }),
      }),
    );
    const vectorStoreSearch = declarations.find(
      (declaration) =>
        declaration.name === 'spanner_vector_store_similarity_search',
    );

    expect(
      Object.keys(vectorStoreSearch?.parameters?.properties ?? {}),
    ).toEqual(['query']);
  });
});
