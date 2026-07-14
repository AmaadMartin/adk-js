/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryRunner, LlmAgent, LOAD_ARTIFACTS} from '@google/adk';
import {Content, createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {GeminiWithMockResponses} from '../test_case_utils.js';

describe('LoadArtifactsTool Integration', () => {
  it('should process load_artifacts function calls and append artifacts', async () => {
    const agent = new LlmAgent({
      name: 'artifact_agent',
      description: 'Reads artifacts.',
      instruction: 'Read the artifact and tell me what is inside.',
      tools: [LOAD_ARTIFACTS],
    });

    agent.model = new GeminiWithMockResponses([
      // First model response requests to load the artifact
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'load_artifacts',
                    args: {artifact_names: ['test.csv']},
                  },
                },
              ],
            },
          },
        ],
      },
      // Second model response happens after the tool provides the content
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'The CSV contains col1,col2 and val1,val2.'}],
            },
          },
        ],
      },
    ]);

    const runner = new InMemoryRunner({
      agent,
      appName: 'test_artifact_app',
    });

    const session = await runner.sessionService.createSession({
      appName: 'test_artifact_app',
      userId: 'test_user',
    });

    // We manually add an artifact to the session using the artifactService
    const csvBytes = Buffer.from('col1,col2\nval1,val2\n', 'utf8').toString(
      'base64',
    );
    await runner.artifactService!.saveArtifact({
      appName: 'test_artifact_app',
      userId: 'test_user',
      sessionId: session.id,
      filename: 'test.csv',
      artifact: {
        inlineData: {
          data: csvBytes,
          mimeType: 'application/csv',
        },
      },
    });

    let finalResponse = '';
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('What is inside test.csv?'),
    })) {
      if (event.author === 'artifact_agent') {
        const text = event.content?.parts?.[0]?.text;
        if (text) finalResponse += text;
      }
    }

    expect(finalResponse).toContain(
      'The CSV contains col1,col2 and val1,val2.',
    );
  });

  it('should save input blob as artifact when saveInputBlobsAsArtifacts is enabled and load it via load_artifacts', async () => {
    const agent = new LlmAgent({
      name: 'blob_agent',
      description: 'Reads saved blobs.',
      instruction: 'Read the artifact and tell me what is inside.',
      tools: [LOAD_ARTIFACTS],
    });

    const runner = new InMemoryRunner({
      agent,
      appName: 'test_blob_app',
    });

    const session = await runner.sessionService.createSession({
      appName: 'test_blob_app',
      userId: 'test_user',
    });

    class DynamicMockGemini extends GeminiWithMockResponses {
      private turn = 0;
      constructor() {
        super([]);
      }
      override async *generateContentAsync(_req: unknown) {
        if (this.turn === 0) {
          this.turn++;
          const keys = await runner.artifactService!.listArtifactKeys({
            appName: 'test_blob_app',
            userId: 'test_user',
            sessionId: session.id,
          });
          yield {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'load_artifacts',
                    args: {artifact_names: keys},
                  },
                },
              ],
            },
          };
        } else {
          this.turn++;
          yield {
            content: {
              role: 'model',
              parts: [{text: 'The saved blob has colA,colB and valA,valB.'}],
            },
          };
        }
      }
    }

    agent.model = new DynamicMockGemini();

    const csvBytes = Buffer.from('colA,colB\nvalA,valB\n', 'utf8').toString(
      'base64',
    );
    const newMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            data: csvBytes,
            mimeType: 'application/csv',
          },
        },
      ],
    };

    let finalResponse = '';
    const events = [];
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage,
      runConfig: {
        saveInputBlobsAsArtifacts: true,
      },
    })) {
      events.push(event);
      if (event.author === 'blob_agent') {
        const text = event.content?.parts?.[0]?.text;
        if (text) finalResponse += text;
      }
    }

    expect(finalResponse).toContain(
      'The saved blob has colA,colB and valA,valB.',
    );

    // Verify the artifact was saved in the artifact service scoped to appName, userId, and sessionId
    const keys = await runner.artifactService!.listArtifactKeys({
      appName: 'test_blob_app',
      userId: 'test_user',
      sessionId: session.id,
    });
    expect(keys.length).toBe(1);
    expect(keys[0]).toMatch(/^artifact_e-[a-z0-9-]+_0$/);
  });
});
