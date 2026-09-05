/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BIGQUERY_TOKEN_CACHE_KEY,
  BigQueryCredentialsConfig,
  BigQueryTool,
  InMemoryRunner,
  LlmAgent,
  OAuth2Auth,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {GeminiWithMockResponses} from '../test_case_utils.js';

const ONE_HOUR_MS = 3600 * 1000;

const APP_NAME = 'bigquery_tool_app';
const USER_ID = 'test_user';
const CLIENT_ID = 'integration-client-id';

describe('BigQueryTool Integration', () => {
  it('runs a BigQuery tool call with the credential cached in the session', async () => {
    let receivedAccessToken: string | undefined;

    function list_datasets() {
      return undefined;
    }

    const tool = new BigQueryTool({
      name: list_datasets.name,
      description: 'Lists the BigQuery datasets in a project.',
      parameters: z.object({projectId: z.string()}),
      credentials: new BigQueryCredentialsConfig({
        clientId: CLIENT_ID,
        clientSecret: 'integration-client-secret',
      }),
      execute: (input, credentials) => {
        receivedAccessToken =
          credentials?.credentials.access_token ?? undefined;
        return {datasets: [`${input.projectId}:sales`]};
      },
    });

    const agent = new LlmAgent({
      name: 'bigquery_agent',
      description: 'Answers questions about BigQuery datasets.',
      instruction: 'Use the tools to answer questions about BigQuery.',
      tools: [tool],
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
                    name: 'list_datasets',
                    args: {projectId: 'demo-project'},
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
              parts: [
                {text: 'The project has one dataset: demo-project:sales.'},
              ],
            },
          },
        ],
      },
    ]);

    const runner = new InMemoryRunner({agent, appName: APP_NAME});
    const session = await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      state: {
        [`${BIGQUERY_TOKEN_CACHE_KEY}_${CLIENT_ID}`]: {
          accessToken: 'session-access-token',
          refreshToken: 'session-refresh-token',
          expiresAt: Date.now() + ONE_HOUR_MS,
        } satisfies OAuth2Auth,
      },
    });

    let finalResponse = '';
    let toolResponse: unknown;
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage: createUserContent('Which datasets does demo-project have?'),
    })) {
      const functionResponse = event.content?.parts?.[0]?.functionResponse;
      if (functionResponse?.name === 'list_datasets') {
        toolResponse = functionResponse.response;
      }
      const text = event.content?.parts?.[0]?.text;
      if (event.author === 'bigquery_agent' && text) {
        finalResponse += text;
      }
    }

    expect(receivedAccessToken).toEqual('session-access-token');
    expect(toolResponse).toEqual({datasets: ['demo-project:sales']});
    expect(finalResponse).toContain('demo-project:sales');
  });

  it('asks the user to authorize when the session holds no credential', async () => {
    const tool = new BigQueryTool({
      name: 'list_datasets',
      description: 'Lists the BigQuery datasets in a project.',
      parameters: z.object({projectId: z.string()}),
      credentials: new BigQueryCredentialsConfig({
        clientId: CLIENT_ID,
        clientSecret: 'integration-client-secret',
      }),
      execute: () => expect.fail('the tool must not run without a credential'),
    });

    const agent = new LlmAgent({
      name: 'bigquery_agent',
      description: 'Answers questions about BigQuery datasets.',
      instruction: 'Use the tools to answer questions about BigQuery.',
      tools: [tool],
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
                    name: 'list_datasets',
                    args: {projectId: 'demo-project'},
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
              parts: [{text: 'Please authorize access to BigQuery.'}],
            },
          },
        ],
      },
    ]);

    const runner = new InMemoryRunner({agent, appName: APP_NAME});
    const session = await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    let toolResponse: unknown;
    let authRequested = false;
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage: createUserContent('Which datasets does demo-project have?'),
    })) {
      const functionResponse = event.content?.parts?.[0]?.functionResponse;
      if (functionResponse?.name === 'list_datasets') {
        toolResponse = functionResponse.response;
      }
      if (Object.keys(event.actions.requestedAuthConfigs).length > 0) {
        authRequested = true;
      }
    }

    expect(toolResponse).toEqual({
      result:
        'User authorization is required to access Google services for ' +
        'list_datasets. Please complete the authorization flow.',
    });
    expect(authRequested).toBe(true);
  });
});
