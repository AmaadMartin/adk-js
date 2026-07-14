/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  createEvent,
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  Runner,
  SaveFilesAsArtifactsPlugin,
} from '@google/adk';
import {Blob, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

class StandaloneE2EAgent extends BaseAgent {
  constructor() {
    super({name: 'e2e_agent'});
  }

  protected async *runAsyncImpl(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: invocationContext.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [{text: 'Processed e2e artifact upload successfully'}],
      },
    });
  }
}

describe('SaveFilesAsArtifactsPlugin Standalone E2E Test (No Mocks)', () => {
  it('should run end-to-end saving inline Blob without mocks using InMemoryArtifactService and SaveFilesAsArtifactsPlugin', async () => {
    const sessionService = new InMemorySessionService();
    const artifactService = new InMemoryArtifactService();
    const plugin = new SaveFilesAsArtifactsPlugin();
    const agent = new StandaloneE2EAgent();

    const runner = new Runner({
      appName: 'e2e_artifact_saving_app',
      agent,
      sessionService,
      artifactService,
      plugins: [plugin],
    });

    const session = await sessionService.createSession({
      appName: 'e2e_artifact_saving_app',
      userId: 'e2e_user',
    });

    const pdfBlob: Blob = {
      displayName: 'financial_report.pdf',
      data: 'SlZCRVJpMHg=',
      mimeType: 'application/pdf',
    };
    const imageBlob: Blob = {
      displayName: 'chart.png',
      data: 'aW1hZ2VkYXRh',
      mimeType: 'image/png',
    };

    const inputParts: Part[] = [
      {inlineData: pdfBlob},
      {text: 'Please analyze the financial report and chart.'},
      {inlineData: imageBlob},
    ];

    const yieldedEvents: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'e2e_user',
      sessionId: session.id,
      newMessage: {role: 'user', parts: inputParts},
    })) {
      yieldedEvents.push(event);
    }

    // 1. Verify both artifacts are persisted to InMemoryArtifactService storage without any mocks
    const storedKeys = await artifactService.listArtifactKeys({
      appName: 'e2e_artifact_saving_app',
      userId: 'e2e_user',
      sessionId: session.id,
    });
    expect(storedKeys).toContain('financial_report.pdf');
    expect(storedKeys).toContain('chart.png');

    const loadedPdf = await artifactService.loadArtifact({
      appName: 'e2e_artifact_saving_app',
      userId: 'e2e_user',
      sessionId: session.id,
      filename: 'financial_report.pdf',
    });
    expect(loadedPdf?.inlineData).toEqual(pdfBlob);

    const loadedImage = await artifactService.loadArtifact({
      appName: 'e2e_artifact_saving_app',
      userId: 'e2e_user',
      sessionId: session.id,
      filename: 'chart.png',
    });
    expect(loadedImage?.inlineData).toEqual(imageBlob);

    // 2. Verify session event log contains clean text placeholders replacing the inline data parts
    const updatedSession = await sessionService.getSession({
      appName: 'e2e_artifact_saving_app',
      userId: 'e2e_user',
      sessionId: session.id,
    });
    expect(updatedSession).toBeDefined();
    const userEvent = updatedSession!.events.find((e) => e.author === 'user');
    expect(userEvent).toBeDefined();
    const partsText = userEvent!
      .content!.parts!.map((p) => p.text)
      .filter(Boolean);
    expect(partsText).toContain('[Uploaded Artifact: "financial_report.pdf"]');
    expect(partsText).toContain(
      'Please analyze the financial report and chart.',
    );
    expect(partsText).toContain('[Uploaded Artifact: "chart.png"]');

    // 3. Verify revision delta is accurately propagated to event.actions.artifactDelta across the pipeline
    const deltaEvent = yieldedEvents.find(
      (e) =>
        e.actions &&
        e.actions.artifactDelta &&
        e.actions.artifactDelta['financial_report.pdf'] === 0 &&
        e.actions.artifactDelta['chart.png'] === 0,
    );
    expect(deltaEvent).toBeDefined();
  });
});
