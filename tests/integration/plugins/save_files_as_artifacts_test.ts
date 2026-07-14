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
import {Blob} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {GeminiWithMockResponses} from '../test_case_utils.js';

describe('SaveFilesAsArtifactsPlugin Integration', () => {
  it('should save inline blobs as artifacts and emit artifact deltas in stream actions', async () => {
    const plugin = new SaveFilesAsArtifactsPlugin();
    const agent = new LlmAgent({
      name: 'artifact_receiver_agent',
      description: 'Receives uploaded files.',
      instruction: 'Process uploaded files.',
    });

    agent.model = new GeminiWithMockResponses([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'I have processed your file.'}],
            },
          },
        ],
      },
    ]);

    const runner = new InMemoryRunner({
      agent,
      appName: 'test_plugin_app',
      plugins: [plugin],
    });

    const session = await runner.sessionService.createSession({
      appName: 'test_plugin_app',
      userId: 'test_user',
    });

    const pdfBytes = Buffer.from('PDF_FILE_CONTENT', 'utf8').toString('base64');
    const inlineData: Blob = {
      displayName: 'my_report.pdf',
      data: pdfBytes,
      mimeType: 'application/pdf',
    };

    let emittedArtifactDelta: Record<string, number> | undefined;
    let modelResponseText = '';

    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [{inlineData}, {text: 'Here is the report.'}],
      },
    })) {
      if (
        event.actions?.artifactDelta &&
        Object.keys(event.actions.artifactDelta).length > 0
      ) {
        emittedArtifactDelta = event.actions.artifactDelta;
      }
      if (event.author === 'artifact_receiver_agent') {
        const text = event.content?.parts?.[0]?.text;
        if (text) modelResponseText += text;
      }
    }

    // Verify model responded
    expect(modelResponseText).toContain('I have processed your file.');

    // Verify artifact delta was recorded and emitted in actions during run
    expect(emittedArtifactDelta).toBeDefined();
    expect(emittedArtifactDelta).toEqual({'my_report.pdf': 0});

    // Verify artifact is persisted in runner's artifact service
    const savedArtifact = await runner.artifactService!.loadArtifact({
      appName: 'test_plugin_app',
      userId: 'test_user',
      sessionId: session.id,
      filename: 'my_report.pdf',
    });
    expect(savedArtifact).toBeDefined();
    expect(savedArtifact!.inlineData).toBeDefined();
    expect(savedArtifact!.inlineData!.data).toBe(pdfBytes);

    // Verify user message in session history was updated to placeholder
    const updatedSession = await runner.sessionService.getSession({
      appName: 'test_plugin_app',
      userId: 'test_user',
      sessionId: session.id,
    });
    expect(updatedSession).not.toBeNull();
    const userEvents = updatedSession!.events.filter(
      (e) => e.author === 'user',
    );
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0].content?.parts?.[0]?.text).toBe(
      '[Uploaded Artifact: "my_report.pdf"]',
    );
  });
});
