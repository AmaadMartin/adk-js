/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InMemoryRunner,
  LlmAgent,
  SaveFilesAsArtifactsPlugin,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {GeminiWithMockResponses} from '../test_case_utils.js';

describe('End-to-End Artifact Upload Integration Test', () => {
  const mockModelResponses = [
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{text: 'I see your uploaded artifact image.'}],
          },
        },
      ],
    },
  ];

  it('should verify end-to-end artifact upload with InMemoryArtifactService and Runner.runAsync({ saveInputBlobsAsArtifacts: true })', async () => {
    const mockLlm = new GeminiWithMockResponses(mockModelResponses);
    const agent = new LlmAgent({
      name: 'artifact_agent',
      model: mockLlm,
    });

    const runner = new InMemoryRunner({
      agent,
      appName: 'test_artifact_app',
    });

    const userId = 'user_integration';
    const session = await runner.sessionService.createSession({
      appName: 'test_artifact_app',
      userId,
    });

    const originalPart: Part = {
      inlineData: {
        data: 'aW50ZWdyYXRpb25fZGF0YQ==', // base64 'integration_data'
        mimeType: 'image/png',
        displayName: 'diagram.png',
      },
    };
    const userMessage: Content = {
      role: 'user',
      parts: [{text: 'Please analyze this diagram'}, originalPart],
    };

    const events = [];
    for await (const event of runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: userMessage,
      runConfig: {
        saveInputBlobsAsArtifacts: true,
      },
    })) {
      events.push(event);
    }

    // 1. Verify that the original caller Part object in un-cloned memory was NOT mutated
    expect(originalPart.inlineData?.data).toBe('aW50ZWdyYXRpb25fZGF0YQ==');
    expect(originalPart.inlineData?.displayName).toBe('diagram.png');

    // 2. Verify that the user event in the session has the placeholder instead of inlineData
    const updatedSession = await runner.sessionService.getSession({
      appName: 'test_artifact_app',
      userId,
      sessionId: session.id,
    });

    expect(updatedSession).not.toBeNull();
    const userEvent = updatedSession!.events.find((e) => e.author === 'user');
    expect(userEvent).toBeDefined();
    expect(userEvent!.actions?.artifactDelta).toHaveProperty('diagram.png');
    const version = userEvent!.actions?.artifactDelta['diagram.png'];
    expect(typeof version).toBe('number');

    expect(userEvent!.content?.parts?.[0]).toEqual({
      text: 'Please analyze this diagram',
    });
    expect(userEvent!.content?.parts?.[1]).toEqual({
      text: '[Uploaded Artifact: "diagram.png"]',
    });

    // 3. Verify that the artifact is stored inside the InMemoryArtifactService and can be loaded
    const loadedArtifact = await runner.artifactService.loadArtifact({
      appName: 'test_artifact_app',
      userId,
      sessionId: session.id,
      filename: 'diagram.png',
      version,
    });

    expect(loadedArtifact).toBeDefined();
    expect(loadedArtifact!.inlineData?.data).toBe('aW50ZWdyYXRpb25fZGF0YQ==');
    expect(loadedArtifact!.inlineData?.mimeType).toBe('image/png');

    // 4. Verify that the model responded cleanly without errors
    const modelEvent = updatedSession!.events.find(
      (e) => e.author === 'artifact_agent',
    );
    expect(modelEvent).toBeDefined();
    expect(modelEvent!.content?.parts?.[0].text).toBe(
      'I see your uploaded artifact image.',
    );
  });

  it('should verify end-to-end artifact upload when SaveFilesAsArtifactsPlugin is registered explicitly', async () => {
    const mockLlm = new GeminiWithMockResponses([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Plugin processed image successfully.'}],
            },
          },
        ],
      },
    ]);

    const agent = new LlmAgent({
      name: 'plugin_artifact_agent',
      model: mockLlm,
    });

    const plugin = new SaveFilesAsArtifactsPlugin({
      attachFileReference: true,
    });

    const runner = new InMemoryRunner({
      agent,
      appName: 'test_plugin_app',
      plugins: [plugin],
    });

    const userId = 'user_plugin_test';
    const session = await runner.sessionService.createSession({
      appName: 'test_plugin_app',
      userId,
    });

    const userMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            data: 'cGx1Z2luX2RhdGE=',
            mimeType: 'image/png',
            displayName: 'chart.png',
          },
        },
      ],
    };

    for await (const _ of runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: userMessage,
    })) {
      // Consume stream
    }

    const updatedSession = await runner.sessionService.getSession({
      appName: 'test_plugin_app',
      userId,
      sessionId: session.id,
    });

    const userEvent = updatedSession!.events.find((e) => e.author === 'user');
    expect(userEvent!.content?.parts?.[0]).toEqual({
      text: '[Uploaded Artifact: "chart.png"]',
    });

    const deltaEvent = updatedSession!.events.find(
      (e) => e.actions?.artifactDelta && 'chart.png' in e.actions.artifactDelta,
    );
    expect(deltaEvent).toBeDefined();
    expect(deltaEvent!.actions?.artifactDelta).toHaveProperty('chart.png');

    const loadedArtifact = await runner.artifactService.loadArtifact({
      appName: 'test_plugin_app',
      userId,
      sessionId: session.id,
      filename: 'chart.png',
    });

    expect(loadedArtifact).toBeDefined();
    expect(loadedArtifact!.inlineData?.data).toBe('cGx1Z2luX2RhdGE=');
  });
});
