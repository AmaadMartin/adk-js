/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getLogger,
  InMemoryRunner,
  LlmAgent,
  SaveFilesAsArtifactsPlugin,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {GeminiWithMockResponses} from '../test_case_utils.js';

describe('SaveFilesAsArtifactsPlugin Integration', () => {
  it('should process multi-turn conversation with image/PDF uploads using SaveFilesAsArtifactsPlugin', async () => {
    const agent = new LlmAgent({
      name: 'file_agent',
      description: 'Processes uploaded files.',
      instruction: 'Review the file and respond.',
    });

    agent.model = new GeminiWithMockResponses([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'I have reviewed report.pdf.'}],
            },
          },
        ],
      },
    ]);

    const plugin = new SaveFilesAsArtifactsPlugin();
    const runner = new InMemoryRunner({
      agent,
      appName: 'test_save_plugin_app',
      plugins: [plugin],
    });

    const session = await runner.sessionService.createSession({
      appName: 'test_save_plugin_app',
      userId: 'test_user',
    });

    const pdfData = Buffer.from('PDF_TEST_DATA', 'utf8').toString('base64');
    let finalResponse = '';

    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {
            inlineData: {
              displayName: 'report.pdf',
              data: pdfData,
              mimeType: 'application/pdf',
            },
          },
        ],
      },
    })) {
      if (event.author === 'file_agent') {
        const text = event.content?.parts?.[0]?.text;
        if (text) finalResponse += text;
      }
    }

    expect(finalResponse).toContain('I have reviewed report.pdf.');

    // Verify artifact was saved into artifactService with the exact displayName
    const savedArtifact = await runner.artifactService!.loadArtifact({
      appName: 'test_save_plugin_app',
      userId: 'test_user',
      sessionId: session.id,
      filename: 'report.pdf',
    });
    expect(savedArtifact).toBeDefined();
    expect(savedArtifact!.inlineData!.data).toBe(pdfData);

    // Verify user event in session history has transformed placeholder part
    // Note: InMemoryArtifactService does not set canonicalUri so fileData reference is omitted
    const updatedSession = await runner.sessionService.getSession({
      appName: 'test_save_plugin_app',
      userId: 'test_user',
      sessionId: session.id,
    });
    expect(updatedSession).not.toBeNull();
    const userEvent = updatedSession!.events[0];
    expect(userEvent.author).toBe('user');
    expect(userEvent.content!.parts).toHaveLength(1);
    expect(userEvent.content!.parts![0].text).toBe(
      '[Uploaded Artifact: "report.pdf"]',
    );
  });

  it('should support backwards compatibility with saveInputBlobsAsArtifacts and log deprecation warning', async () => {
    const agent = new LlmAgent({
      name: 'legacy_agent',
      description: 'Processes uploaded files via legacy config.',
      instruction: 'Review the file and respond.',
    });

    agent.model = new GeminiWithMockResponses([
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'I have reviewed legacy.png.'}],
            },
          },
        ],
      },
    ]);

    const runner = new InMemoryRunner({
      agent,
      appName: 'test_legacy_app',
    });

    const session = await runner.sessionService.createSession({
      appName: 'test_legacy_app',
      userId: 'test_user',
    });

    const warnSpy = vi.spyOn(getLogger(), 'warn');
    const imgData = Buffer.from('IMG_TEST_DATA', 'utf8').toString('base64');
    let finalResponse = '';

    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {
            inlineData: {
              displayName: 'legacy.png',
              data: imgData,
              mimeType: 'image/png',
            },
          },
        ],
      },
      runConfig: {saveInputBlobsAsArtifacts: true},
    })) {
      if (event.author === 'legacy_agent') {
        const text = event.content?.parts?.[0]?.text;
        if (text) finalResponse += text;
      }
    }

    expect(warnSpy).toHaveBeenCalledWith(
      "The 'saveInputBlobsAsArtifacts' parameter is deprecated. Use SaveFilesAsArtifactsPlugin instead for better control and flexibility.",
    );
    expect(finalResponse).toContain('I have reviewed legacy.png.');

    // Verify artifact was saved into artifactService using legacy generated filename
    const keys = await runner.artifactService!.listArtifactKeys({
      appName: 'test_legacy_app',
      userId: 'test_user',
      sessionId: session.id,
    });
    expect(keys).toHaveLength(1);
    const savedArtifact = await runner.artifactService!.loadArtifact({
      appName: 'test_legacy_app',
      userId: 'test_user',
      sessionId: session.id,
      filename: keys[0],
    });
    expect(savedArtifact).toBeDefined();
    expect(savedArtifact!.inlineData!.data).toBe(imgData);

    warnSpy.mockRestore();
  });
});
