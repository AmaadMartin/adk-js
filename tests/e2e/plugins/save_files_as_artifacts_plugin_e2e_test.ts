/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  createEvent,
  Event,
  InMemoryRunner,
  InvocationContext,
  SaveFilesAsArtifactsPlugin,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'save_files_e2e';
const USER_ID = 'e2e_user';

/**
 * A minimal real agent (no LLM, no mocks) that echoes back the content of the
 * most recent user event it observes. It lets the E2E assert what the plugin
 * left in the conversation the agent actually sees.
 */
class EchoUserContentAgent extends BaseAgent {
  lastUserContent?: Content;

  constructor() {
    super({name: 'echo_agent'});
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const userEvents = context.session.events.filter(
      (e) => e.author === 'user',
    );
    this.lastUserContent = userEvents[userEvents.length - 1]?.content;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: 'ack'}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

/** Builds a real runner (in-memory services, no mocks) with the plugin installed. */
async function createRunner() {
  const agent = new EchoUserContentAgent();
  const runner = new InMemoryRunner({
    agent,
    appName: APP_NAME,
    plugins: [new SaveFilesAsArtifactsPlugin()],
  });
  const session = await runner.sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  return {agent, runner, session};
}

describe('E2E SaveFilesAsArtifactsPlugin', () => {
  it('persists an uploaded blob and swaps it for a placeholder end-to-end', async () => {
    const {agent, runner, session} = await createRunner();

    const pdfBytes = Buffer.from('%PDF-1.4 fake report', 'utf8').toString(
      'base64',
    );
    const newMessage: Content = {
      role: 'user',
      parts: [
        {text: 'Please review this.'},
        {
          inlineData: {
            displayName: 'quarterly_report.pdf',
            data: pdfBytes,
            mimeType: 'application/pdf',
          },
        },
      ],
    };

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage,
    })) {
      events.push(event);
    }

    // The agent ran and produced its response.
    expect(events.some((e) => e.author === 'echo_agent')).toBe(true);

    // The placeholder replaced the raw bytes in the conversation the agent saw.
    const seenParts = agent.lastUserContent?.parts ?? [];
    expect(seenParts.some((p) => p.text === 'Please review this.')).toBe(true);
    expect(
      seenParts.some(
        (p) => p.text === '[Uploaded Artifact: "quarterly_report.pdf"]',
      ),
    ).toBe(true);
    // Raw bytes are gone from the prompt.
    expect(seenParts.some((p) => p.inlineData)).toBe(false);
    // The in-memory service exposes no model-accessible URI, so no fileData
    // reference is attached.
    expect(seenParts.some((p) => p.fileData)).toBe(false);

    // The blob was actually persisted to the artifact service under its name.
    const keys = await runner.artifactService!.listArtifactKeys({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });
    expect(keys).toContain('quarterly_report.pdf');

    const saved = await runner.artifactService!.loadArtifact({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
      filename: 'quarterly_report.pdf',
    });
    expect(saved?.inlineData?.data).toBe(pdfBytes);
  });

  it('leaves an error in place of a blob over the 20MB limit', async () => {
    const {agent, runner, session} = await createRunner();

    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64');
    const newMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            displayName: 'huge.pdf',
            data: oversized,
            mimeType: 'application/pdf',
          },
        },
      ],
    };

    for await (const _event of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage,
    })) {
      // Drain the generator so the run completes.
    }

    const seenParts = agent.lastUserContent?.parts ?? [];
    expect(seenParts[0].text).toBe(
      '[Upload Error: File huge.pdf (20.00 MB) exceeds the maximum supported' +
        ' size of 20MB. Please upload a smaller file.]',
    );
    expect(seenParts.some((p) => p.inlineData)).toBe(false);

    const keys = await runner.artifactService!.listArtifactKeys({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });
    expect(keys).toHaveLength(0);
  });

  // Complements the unit test for this branch by proving the fallback name is
  // built from a real runner-generated invocation id, not a fixture string.
  it('generates a filename when the uploaded blob has no displayName', async () => {
    const {agent, runner, session} = await createRunner();

    const bytes = Buffer.from('hello world', 'utf8').toString('base64');
    const newMessage: Content = {
      role: 'user',
      parts: [{inlineData: {data: bytes, mimeType: 'text/plain'}}],
    };

    for await (const _event of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage,
    })) {
      // Drain the generator so the run completes.
    }

    const keys = await runner.artifactService!.listArtifactKeys({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^artifact_.*_0$/);

    const seenParts = agent.lastUserContent?.parts ?? [];
    expect(
      seenParts.some((p) =>
        p.text?.startsWith('[Uploaded Artifact: "artifact_'),
      ),
    ).toBe(true);
  });
});
