/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BasePlugin,
  Context,
  createEvent,
  getLogger,
  InMemorySessionService,
  InvocationContext,
  Logger,
  PluginManager,
  SaveFilesAsArtifactsPlugin,
  SessionArtifactService,
  setLogger,
  State,
} from '@google/adk';
import {Blob, Content, Part} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * Builds a fresh mock artifact service and invocation context for each test,
 * mirroring the adk-python test harness. The mocked `getArtifactVersion`
 * returns a model-accessible `gs://` URI by default.
 */
interface MockArtifactVersion {
  version: number;
  canonicalUri?: string;
  mimeType?: string;
}

function createHarness() {
  const saveArtifact = vi.fn().mockResolvedValue(0);
  const getArtifactVersion = vi.fn<
    (req: {
      filename: string;
      version: number;
    }) => Promise<MockArtifactVersion | undefined>
  >(async ({filename, version}) => ({
    version,
    canonicalUri: `gs://mock-bucket/${filename}/versions/${version}`,
    mimeType: 'application/pdf',
  }));
  const artifactService = {
    saveArtifact,
    getArtifactVersion,
  } as unknown as SessionArtifactService;

  const invocationContext = {
    artifactService,
    invocationId: 'test_invocation_123',
    session: {id: 'test_session', state: {} as Record<string, unknown>},
  } as unknown as InvocationContext;

  return {saveArtifact, getArtifactVersion, artifactService, invocationContext};
}

const mockAgent = {name: 'test_agent'} as BaseAgent;

/**
 * The plugin's cross-callback bookkeeping key. The `temp:` prefix is part of
 * the contract: session services skip persisting `temp:`-prefixed keys, so this
 * never lands in durable session state.
 */
const PENDING_DELTA_KEY = 'temp:save_files_as_artifacts_plugin:pending_delta';

describe('SaveFilesAsArtifactsPlugin', () => {
  let originalLogger: Logger;
  let warnMessages: string[];
  let errorMessages: string[];

  beforeEach(() => {
    originalLogger = getLogger();
    warnMessages = [];
    errorMessages = [];
    setLogger({
      setLogLevel: () => {},
      log: () => {},
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => {
        warnMessages.push(args.map((a) => String(a)).join(' '));
      },
      error: (...args: unknown[]) => {
        errorMessages.push(args.map((a) => String(a)).join(' '));
      },
    });
  });

  afterEach(() => {
    setLogger(originalLogger);
  });

  it('saves a file that has a displayName and attaches a file reference', async () => {
    const {invocationContext, saveArtifact} = createHarness();
    const plugin = new SaveFilesAsArtifactsPlugin();

    const inlineData: Blob = {
      displayName: 'test_document.pdf',
      data: 'dGVzdCBkYXRh',
      mimeType: 'application/pdf',
    };
    const originalPart: Part = {inlineData};
    const userMessage: Content = {role: 'user', parts: [originalPart]};

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    expect(saveArtifact).toHaveBeenCalledTimes(1);
    expect(saveArtifact).toHaveBeenCalledWith({
      filename: 'test_document.pdf',
      artifact: originalPart,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(2);
    expect(result!.parts![0].text).toBe(
      '[Uploaded Artifact: "test_document.pdf"]',
    );
    expect(result!.parts![1].fileData).toBeDefined();
    expect(result!.parts![1].fileData!.fileUri).toBe(
      'gs://mock-bucket/test_document.pdf/versions/0',
    );
    expect(result!.parts![1].fileData!.displayName).toBe('test_document.pdf');
    expect(result!.parts![1].fileData!.mimeType).toBe('application/pdf');
  });

  it('does not attach a file reference when attachFileReference is false', async () => {
    const {invocationContext, saveArtifact, getArtifactVersion} =
      createHarness();
    const plugin = new SaveFilesAsArtifactsPlugin(
      'save_files_as_artifacts_plugin',
      {attachFileReference: false},
    );

    const inlineData: Blob = {
      displayName: 'test_document.pdf',
      data: 'dGVzdCBkYXRh',
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {role: 'user', parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    expect(saveArtifact).toHaveBeenCalledTimes(1);
    expect(getArtifactVersion).not.toHaveBeenCalled();
    expect(result!.parts).toHaveLength(1);
    expect(result!.parts![0].text).toBe(
      '[Uploaded Artifact: "test_document.pdf"]',
    );
  });

  it('generates a filename when displayName is missing', async () => {
    const {invocationContext, saveArtifact} = createHarness();
    const plugin = new SaveFilesAsArtifactsPlugin();

    const inlineData: Blob = {
      data: 'dGVzdCBkYXRh',
      mimeType: 'application/pdf',
    };
    const originalPart: Part = {inlineData};
    const userMessage: Content = {role: 'user', parts: [originalPart]};

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    const expectedFilename = 'artifact_test_invocation_123_0';
    expect(saveArtifact).toHaveBeenCalledWith({
      filename: expectedFilename,
      artifact: originalPart,
    });

    expect(result!.parts).toHaveLength(2);
    expect(result!.parts![0].text).toBe(
      `[Uploaded Artifact: "${expectedFilename}"]`,
    );
    expect(result!.parts![1].fileData!.fileUri).toBe(
      `gs://mock-bucket/${expectedFilename}/versions/0`,
    );
    expect(result!.parts![1].fileData!.displayName).toBe(expectedFilename);
  });

  it('handles multiple files with interleaved text, preserving order', async () => {
    const {invocationContext, saveArtifact} = createHarness();
    const plugin = new SaveFilesAsArtifactsPlugin();

    const inlineData1: Blob = {
      displayName: 'file1.txt',
      data: 'ZmlsZTE=',
      mimeType: 'text/plain',
    };
    const inlineData2: Blob = {
      displayName: 'file2.jpg',
      data: 'ZmlsZTI=',
      mimeType: 'image/jpeg',
    };
    const userMessage: Content = {
      role: 'user',
      parts: [
        {inlineData: inlineData1},
        {text: 'Some text between files'},
        {inlineData: inlineData2},
      ],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    expect(saveArtifact).toHaveBeenCalledTimes(2);
    expect(saveArtifact.mock.calls[0][0].filename).toBe('file1.txt');
    expect(saveArtifact.mock.calls[1][0].filename).toBe('file2.jpg');

    expect(result!.parts).toHaveLength(5);
    expect(result!.parts![0].text).toBe('[Uploaded Artifact: "file1.txt"]');
    expect(result!.parts![1].fileData!.fileUri).toBe(
      'gs://mock-bucket/file1.txt/versions/0',
    );
    expect(result!.parts![1].fileData!.displayName).toBe('file1.txt');
    expect(result!.parts![2].text).toBe('Some text between files');
    expect(result!.parts![3].text).toBe('[Uploaded Artifact: "file2.jpg"]');
    expect(result!.parts![4].fileData!.fileUri).toBe(
      'gs://mock-bucket/file2.jpg/versions/0',
    );
    expect(result!.parts![4].fileData!.displayName).toBe('file2.jpg');
  });

  it('leaves the message untouched and warns when no artifact service is set', async () => {
    const {invocationContext} = createHarness();
    (invocationContext as {artifactService?: unknown}).artifactService =
      undefined;
    const plugin = new SaveFilesAsArtifactsPlugin();

    const inlineData: Blob = {
      displayName: 'test.pdf',
      data: 'dGVzdCBkYXRh',
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {role: 'user', parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    // `undefined` means "proceed normally" per the BasePlugin contract, so the
    // runner keeps the original message and later plugins still run.
    expect(result).toBeUndefined();
    expect(userMessage.parts![0].inlineData).toBe(inlineData);
    expect(
      warnMessages.some((m) => m.includes('Artifact service is not set')),
    ).toBe(true);
  });

  it('does not short-circuit later plugins when no artifact service is set', async () => {
    const {invocationContext} = createHarness();
    (invocationContext as {artifactService?: unknown}).artifactService =
      undefined;

    const laterPluginSaw: Content[] = [];
    class RecordingPlugin extends BasePlugin {
      constructor() {
        super('recording_plugin');
      }
      override async onUserMessageCallback({
        userMessage,
      }: {
        invocationContext: InvocationContext;
        userMessage: Content;
      }): Promise<Content | undefined> {
        laterPluginSaw.push(userMessage);
        return undefined;
      }
    }

    const manager = new PluginManager([
      new SaveFilesAsArtifactsPlugin(),
      new RecordingPlugin(),
    ]);
    const userMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            displayName: 'test.pdf',
            data: 'dGVzdCBkYXRh',
            mimeType: 'application/pdf',
          },
        },
      ],
    };

    const result = await manager.runOnUserMessageCallback({
      userMessage,
      invocationContext,
    });

    expect(result).toBeUndefined();
    expect(laterPluginSaw).toEqual([userMessage]);
  });

  it('returns undefined when the message has no parts array', async () => {
    const {invocationContext, saveArtifact} = createHarness();
    const plugin = new SaveFilesAsArtifactsPlugin();

    const userMessage: Content = {role: 'user'};

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    expect(result).toBeUndefined();
    expect(saveArtifact).not.toHaveBeenCalled();
  });

  it('returns undefined when the message has an empty parts array', async () => {
    const {invocationContext, saveArtifact} = createHarness();
    const plugin = new SaveFilesAsArtifactsPlugin();

    const userMessage: Content = {role: 'user', parts: []};

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    expect(result).toBeUndefined();
    expect(saveArtifact).not.toHaveBeenCalled();
  });

  it('returns undefined when no parts contain inlineData', async () => {
    const {invocationContext, saveArtifact} = createHarness();
    const plugin = new SaveFilesAsArtifactsPlugin();

    const userMessage: Content = {
      role: 'user',
      parts: [{text: 'Hello world'}, {text: 'No files here'}],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    expect(result).toBeUndefined();
    expect(saveArtifact).not.toHaveBeenCalled();
  });

  it('returns undefined and keeps going when a single save fails', async () => {
    const {invocationContext, saveArtifact} = createHarness();
    saveArtifact.mockRejectedValue(new Error('Storage error'));
    const plugin = new SaveFilesAsArtifactsPlugin();

    const inlineData: Blob = {
      displayName: 'test.pdf',
      data: 'dGVzdCBkYXRh',
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {role: 'user', parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    expect(result).toBeUndefined();
    expect(
      errorMessages.some((m) => m.includes('Failed to save artifact')),
    ).toBe(true);
  });

  it('keeps the original part for a failed save while saving the rest', async () => {
    const {invocationContext, saveArtifact} = createHarness();
    saveArtifact
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('Storage error on second file'));
    const plugin = new SaveFilesAsArtifactsPlugin();

    const inlineData1: Blob = {
      displayName: 'success.pdf',
      data: 'c3VjY2Vzcw==',
      mimeType: 'application/pdf',
    };
    const inlineData2: Blob = {
      displayName: 'failure.pdf',
      data: 'ZmFpbHVyZQ==',
      mimeType: 'application/pdf',
    };
    const failingPart: Part = {inlineData: inlineData2};
    const userMessage: Content = {
      role: 'user',
      parts: [{inlineData: inlineData1}, failingPart],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    expect(result!.parts).toHaveLength(3);
    expect(result!.parts![0].text).toBe('[Uploaded Artifact: "success.pdf"]');
    expect(result!.parts![1].fileData).toBeDefined();
    expect(result!.parts![2]).toBe(failingPart);
    expect(result!.parts![2].inlineData).toBe(inlineData2);
  });

  it('formats the placeholder text for filenames with spaces', async () => {
    const {invocationContext} = createHarness();
    const plugin = new SaveFilesAsArtifactsPlugin();

    const inlineData: Blob = {
      displayName: 'test file with spaces.docx',
      data: 'ZG9jdW1lbnQ=',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    const userMessage: Content = {role: 'user', parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    expect(result!.parts![0].text).toBe(
      '[Uploaded Artifact: "test file with spaces.docx"]',
    );
    expect(result!.parts![1].fileData).toBeDefined();
  });

  it('uses the default plugin name and honors a custom name', () => {
    expect(new SaveFilesAsArtifactsPlugin().name).toBe(
      'save_files_as_artifacts_plugin',
    );
    expect(new SaveFilesAsArtifactsPlugin('custom').name).toBe('custom');
  });

  it('passes a user: prefixed filename through verbatim', async () => {
    const {invocationContext, saveArtifact} = createHarness();
    const plugin = new SaveFilesAsArtifactsPlugin();

    const inlineData: Blob = {
      displayName: 'user:profile.png',
      data: 'aW1n',
      mimeType: 'image/png',
    };
    const userMessage: Content = {role: 'user', parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext,
      userMessage,
    });

    expect(saveArtifact).toHaveBeenCalledWith({
      filename: 'user:profile.png',
      artifact: {inlineData},
    });
    expect(result!.parts![0].text).toBe(
      '[Uploaded Artifact: "user:profile.png"]',
    );
  });

  describe('file reference resolution branches', () => {
    it('emits only the placeholder when the URI is not model-accessible', async () => {
      const {invocationContext, getArtifactVersion} = createHarness();
      getArtifactVersion.mockResolvedValue({
        version: 0,
        canonicalUri: 'file:///tmp/x',
        mimeType: 'application/pdf',
      });
      const plugin = new SaveFilesAsArtifactsPlugin();

      const inlineData: Blob = {
        displayName: 'local.pdf',
        data: 'ZGF0YQ==',
        mimeType: 'application/pdf',
      };
      const userMessage: Content = {role: 'user', parts: [{inlineData}]};

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage,
      });

      expect(result!.parts).toHaveLength(1);
      expect(result!.parts![0].text).toBe('[Uploaded Artifact: "local.pdf"]');
    });

    it('emits only the placeholder when the URI has no scheme', async () => {
      const {invocationContext, getArtifactVersion} = createHarness();
      getArtifactVersion.mockResolvedValue({
        version: 0,
        canonicalUri: 'relative/path/no/scheme',
        mimeType: 'application/pdf',
      });
      const plugin = new SaveFilesAsArtifactsPlugin();

      const inlineData: Blob = {
        displayName: 'noscheme.pdf',
        data: 'ZGF0YQ==',
        mimeType: 'application/pdf',
      };
      const userMessage: Content = {role: 'user', parts: [{inlineData}]};

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage,
      });

      expect(result!.parts).toHaveLength(1);
      expect(result!.parts![0].text).toBe(
        '[Uploaded Artifact: "noscheme.pdf"]',
      );
    });

    it('emits only the placeholder when getArtifactVersion returns undefined', async () => {
      const {invocationContext, getArtifactVersion} = createHarness();
      getArtifactVersion.mockResolvedValue(undefined);
      const plugin = new SaveFilesAsArtifactsPlugin();

      const inlineData: Blob = {
        displayName: 'gone.pdf',
        data: 'ZGF0YQ==',
        mimeType: 'application/pdf',
      };
      const userMessage: Content = {role: 'user', parts: [{inlineData}]};

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage,
      });

      expect(result!.parts).toHaveLength(1);
      expect(result!.parts![0].text).toBe('[Uploaded Artifact: "gone.pdf"]');
    });

    it('emits only the placeholder when the resolved version has no canonicalUri', async () => {
      const {invocationContext, getArtifactVersion} = createHarness();
      getArtifactVersion.mockResolvedValue({version: 0});
      const plugin = new SaveFilesAsArtifactsPlugin();

      const inlineData: Blob = {
        displayName: 'nouri.pdf',
        data: 'ZGF0YQ==',
        mimeType: 'application/pdf',
      };
      const userMessage: Content = {role: 'user', parts: [{inlineData}]};

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage,
      });

      expect(result!.parts).toHaveLength(1);
      expect(result!.parts![0].text).toBe('[Uploaded Artifact: "nouri.pdf"]');
    });

    it('emits only the placeholder and warns when getArtifactVersion rejects', async () => {
      const {invocationContext, getArtifactVersion} = createHarness();
      getArtifactVersion.mockRejectedValue(new Error('lookup failed'));
      const plugin = new SaveFilesAsArtifactsPlugin();

      const inlineData: Blob = {
        displayName: 'boom.pdf',
        data: 'ZGF0YQ==',
        mimeType: 'application/pdf',
      };
      const userMessage: Content = {role: 'user', parts: [{inlineData}]};

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage,
      });

      expect(result!.parts).toHaveLength(1);
      expect(result!.parts![0].text).toBe('[Uploaded Artifact: "boom.pdf"]');
      expect(
        warnMessages.some((m) =>
          m.includes('Failed to resolve artifact version'),
        ),
      ).toBe(true);
    });

    it('falls back to the resolved mimeType when the blob has none', async () => {
      const {invocationContext} = createHarness();
      const plugin = new SaveFilesAsArtifactsPlugin();

      const inlineData: Blob = {displayName: 'no_mime.pdf', data: 'ZGF0YQ=='};
      const userMessage: Content = {role: 'user', parts: [{inlineData}]};

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage,
      });

      expect(result!.parts![1].fileData!.mimeType).toBe('application/pdf');
    });
  });

  describe('artifact delta reporting', () => {
    it('records the pending delta into session state', async () => {
      const {invocationContext} = createHarness();
      const plugin = new SaveFilesAsArtifactsPlugin();

      const blob: Blob = {
        displayName: 'blob.pdf',
        data: 'ZGF0YQ==',
        mimeType: 'application/pdf',
      };
      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {role: 'user', parts: [{inlineData: blob}]},
      });

      expect(invocationContext.session.state[PENDING_DELTA_KEY]).toEqual({
        'blob.pdf': 0,
      });
    });

    it('merges a new delta into an existing pending delta', async () => {
      const {invocationContext} = createHarness();
      invocationContext.session.state[PENDING_DELTA_KEY] = {'existing.pdf': 3};
      const plugin = new SaveFilesAsArtifactsPlugin();

      const blob: Blob = {
        displayName: 'blob.pdf',
        data: 'ZGF0YQ==',
        mimeType: 'application/pdf',
      };
      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {role: 'user', parts: [{inlineData: blob}]},
      });

      expect(invocationContext.session.state[PENDING_DELTA_KEY]).toEqual({
        'existing.pdf': 3,
        'blob.pdf': 0,
      });
    });

    it('flushes the pending delta into actions.artifactDelta and resets state across turns', async () => {
      const {invocationContext} = createHarness();
      const plugin = new SaveFilesAsArtifactsPlugin();

      // Turn 1: user message callback records the delta in state.
      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          role: 'user',
          parts: [
            {
              inlineData: {
                displayName: 'blob.pdf',
                data: 'ZGF0YQ==',
                mimeType: 'application/pdf',
              },
            },
          ],
        },
      });
      expect(invocationContext.session.state[PENDING_DELTA_KEY]).toEqual({
        'blob.pdf': 0,
      });

      // Turn 1: before-agent callback flushes the delta and clears the state.
      const callbackContext1 = {
        state: new State(invocationContext.session.state),
        actions: {artifactDelta: {} as Record<string, number>},
      } as unknown as Context;
      await plugin.beforeAgentCallback({
        agent: mockAgent,
        callbackContext: callbackContext1,
      });
      expect(callbackContext1.actions.artifactDelta).toEqual({'blob.pdf': 0});
      expect(invocationContext.session.state[PENDING_DELTA_KEY]).toEqual({});

      // Turn 2: a new upload records only the new delta (no accumulation).
      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          role: 'user',
          parts: [
            {
              inlineData: {
                displayName: 'blob_2.pdf',
                data: 'ZGF0YTI=',
                mimeType: 'application/pdf',
              },
            },
          ],
        },
      });
      expect(invocationContext.session.state[PENDING_DELTA_KEY]).toEqual({
        'blob_2.pdf': 0,
      });

      // Turn 2: before-agent callback flushes the second delta.
      const callbackContext2 = {
        state: new State(invocationContext.session.state),
        actions: {artifactDelta: {} as Record<string, number>},
      } as unknown as Context;
      await plugin.beforeAgentCallback({
        agent: mockAgent,
        callbackContext: callbackContext2,
      });
      expect(callbackContext2.actions.artifactDelta).toEqual({'blob_2.pdf': 0});
      expect(invocationContext.session.state[PENDING_DELTA_KEY]).toEqual({});
    });

    it('is a no-op when there is no pending delta', async () => {
      const {invocationContext} = createHarness();
      const plugin = new SaveFilesAsArtifactsPlugin();

      const callbackContext = {
        state: new State(invocationContext.session.state),
        actions: {artifactDelta: {} as Record<string, number>},
      } as unknown as Context;

      const result = await plugin.beforeAgentCallback({
        agent: mockAgent,
        callbackContext,
      });

      expect(result).toBeUndefined();
      expect(callbackContext.actions.artifactDelta).toEqual({});
    });

    it('is a no-op when the pending delta is empty', async () => {
      const {invocationContext} = createHarness();
      invocationContext.session.state[PENDING_DELTA_KEY] = {};
      const plugin = new SaveFilesAsArtifactsPlugin();

      const callbackContext = {
        state: new State(invocationContext.session.state),
        actions: {artifactDelta: {} as Record<string, number>},
      } as unknown as Context;

      await plugin.beforeAgentCallback({
        agent: mockAgent,
        callbackContext,
      });

      expect(callbackContext.actions.artifactDelta).toEqual({});
    });

    it('keeps the bookkeeping key out of durable session state', async () => {
      const sessionService = new InMemorySessionService();
      const session = await sessionService.createSession({
        appName: 'test_app',
        userId: 'test_user',
      });
      const {artifactService} = createHarness();
      const invocationContext = {
        artifactService,
        invocationId: 'test_invocation_123',
        session,
      } as unknown as InvocationContext;
      const plugin = new SaveFilesAsArtifactsPlugin();

      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          role: 'user',
          parts: [
            {
              inlineData: {
                displayName: 'blob.pdf',
                data: 'ZGF0YQ==',
                mimeType: 'application/pdf',
              },
            },
          ],
        },
      });

      // A real Context routes state writes into eventActions.stateDelta, which
      // is what a session service would persist.
      const callbackContext = new Context({invocationContext});
      await plugin.beforeAgentCallback({
        agent: mockAgent,
        callbackContext,
      });
      expect(callbackContext.actions.artifactDelta).toEqual({'blob.pdf': 0});

      const appended = await sessionService.appendEvent({
        session,
        event: createEvent({
          invocationId: invocationContext.invocationId,
          author: 'test_agent',
          actions: callbackContext.eventActions,
        }),
      });

      // Nothing resembling the bookkeeping key survives into the persisted
      // delta, so it never lands in durable session state.
      expect(
        Object.keys(appended.actions.stateDelta).some((k) =>
          k.includes('pending_delta'),
        ),
      ).toBe(false);
      const reloaded = await sessionService.getSession({
        appName: 'test_app',
        userId: 'test_user',
        sessionId: session.id,
      });
      expect(
        Object.keys(reloaded!.state).some(
          (k) => k.includes('pending_delta') && !k.startsWith('temp:'),
        ),
      ).toBe(false);
    });
  });
});
