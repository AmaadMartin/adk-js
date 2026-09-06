/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  createSession,
  getLogger,
  InvocationContext,
  Logger,
  PluginManager,
  SaveFilesAsArtifactsPlugin,
  SessionArtifactService,
  setLogger,
} from '@google/adk';
import {Blob, Content, Part} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const APP_NAME = 'test_app';
const USER_ID = 'test_user';
const INVOCATION_ID = 'test_invocation_123';

/** The inline-data ceiling the plugin enforces, mirrored from the source. */
const MAX_INLINE_DATA_SIZE_BYTES = 20 * 1024 * 1024;

/**
 * Builds a base64 payload that decodes to exactly `bytes` bytes. The padding is
 * derived from the byte count, so the string is valid base64 rather than a
 * string of the right length.
 */
function base64OfSize(bytes: number): string {
  const padding = (3 - (bytes % 3)) % 3;
  const encodedLength = ((bytes + padding) / 3) * 4;
  return 'A'.repeat(encodedLength - padding) + '='.repeat(padding);
}

/**
 * Builds a fake artifact service whose calls are observable. Every method is a
 * spy so the fake satisfies {@link SessionArtifactService} without a cast, and
 * `getArtifactVersion` resolves to a model-accessible `gs://` URI by default.
 */
function createFakeArtifactService() {
  const saveArtifact = vi.fn<SessionArtifactService['saveArtifact']>(
    async () => 0,
  );
  const getArtifactVersion = vi.fn<
    SessionArtifactService['getArtifactVersion']
  >(async ({filename, version}) => ({
    version: version ?? 0,
    canonicalUri: `gs://mock-bucket/${filename}/versions/${version}`,
    mimeType: 'application/pdf',
  }));
  const artifactService: SessionArtifactService = {
    saveArtifact,
    getArtifactVersion,
    loadArtifact: vi.fn(async () => undefined),
    listArtifactKeys: vi.fn(async () => []),
    deleteArtifact: vi.fn(async () => {}),
    listVersions: vi.fn(async () => []),
    listArtifactVersions: vi.fn(async () => []),
  };

  return {saveArtifact, getArtifactVersion, artifactService};
}

/**
 * Builds a fresh fake artifact service and a real invocation context for each
 * test, mirroring the adk-python test harness.
 */
function createHarness(
  session = createSession({
    id: 'test_session',
    appName: APP_NAME,
    userId: USER_ID,
  }),
) {
  const {saveArtifact, getArtifactVersion, artifactService} =
    createFakeArtifactService();

  const invocationContext = new InvocationContext({
    invocationId: INVOCATION_ID,
    session,
    artifactService,
    pluginManager: new PluginManager(),
  });

  return {saveArtifact, getArtifactVersion, artifactService, invocationContext};
}

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

  describe('file size limit', () => {
    it('saves a file whose decoded size is exactly the limit', async () => {
      const {invocationContext, saveArtifact} = createHarness();
      const plugin = new SaveFilesAsArtifactsPlugin();

      const inlineData: Blob = {
        displayName: 'exactly_20mb.pdf',
        data: base64OfSize(MAX_INLINE_DATA_SIZE_BYTES),
        mimeType: 'application/pdf',
      };

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {role: 'user', parts: [{inlineData}]},
      });

      expect(saveArtifact).toHaveBeenCalledTimes(1);
      expect(result!.parts![0].text).toBe(
        '[Uploaded Artifact: "exactly_20mb.pdf"]',
      );
    });

    it('saves a blob that carries no data', async () => {
      const {invocationContext, saveArtifact} = createHarness();
      const plugin = new SaveFilesAsArtifactsPlugin();

      const inlineData: Blob = {
        displayName: 'empty.pdf',
        mimeType: 'application/pdf',
      };

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {role: 'user', parts: [{inlineData}]},
      });

      expect(saveArtifact).toHaveBeenCalledTimes(1);
      expect(result!.parts![0].text).toBe('[Uploaded Artifact: "empty.pdf"]');
    });

    it('rejects a file one byte over the limit', async () => {
      const {invocationContext, saveArtifact} = createHarness();
      const plugin = new SaveFilesAsArtifactsPlugin();

      const inlineData: Blob = {
        displayName: 'over_limit.pdf',
        data: base64OfSize(MAX_INLINE_DATA_SIZE_BYTES + 1),
        mimeType: 'application/pdf',
      };

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {role: 'user', parts: [{inlineData}]},
      });

      expect(saveArtifact).not.toHaveBeenCalled();
      expect(result!.parts).toHaveLength(1);
      expect(result!.parts![0].text).toBe(
        '[Upload Error: File over_limit.pdf (20.00 MB) exceeds the maximum' +
          ' supported size of 20MB. Please upload a smaller file.]',
      );
      expect(
        warnMessages.some((m) => m.includes('exceeds the maximum supported')),
      ).toBe(true);
    });

    it('reports the size in megabytes for a 21MB file', async () => {
      const {invocationContext, saveArtifact} = createHarness();
      const plugin = new SaveFilesAsArtifactsPlugin();

      const inlineData: Blob = {
        displayName: 'big.pdf',
        data: base64OfSize(21 * 1024 * 1024),
        mimeType: 'application/pdf',
      };

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {role: 'user', parts: [{inlineData}]},
      });

      expect(saveArtifact).not.toHaveBeenCalled();
      expect(result!.parts![0].text).toBe(
        '[Upload Error: File big.pdf (21.00 MB) exceeds the maximum supported' +
          ' size of 20MB. Please upload a smaller file.]',
      );
    });

    it('names an oversized file without a displayName by its generated name', async () => {
      const {invocationContext} = createHarness();
      const plugin = new SaveFilesAsArtifactsPlugin();

      const inlineData: Blob = {
        data: base64OfSize(MAX_INLINE_DATA_SIZE_BYTES + 1),
        mimeType: 'application/pdf',
      };

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {role: 'user', parts: [{inlineData}]},
      });

      expect(result!.parts![0].text).toContain(
        '[Upload Error: File artifact_test_invocation_123_0 (20.00 MB)',
      );
    });

    it('saves the small file and rejects the large one in the same message', async () => {
      const {invocationContext, saveArtifact} = createHarness();
      const plugin = new SaveFilesAsArtifactsPlugin();

      const userMessage: Content = {
        role: 'user',
        parts: [
          {
            inlineData: {
              displayName: 'small.pdf',
              data: base64OfSize(5 * 1024 * 1024),
              mimeType: 'application/pdf',
            },
          },
          {
            inlineData: {
              displayName: 'large.pdf',
              data: base64OfSize(25 * 1024 * 1024),
              mimeType: 'application/pdf',
            },
          },
        ],
      };

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage,
      });

      expect(saveArtifact).toHaveBeenCalledTimes(1);
      expect(saveArtifact.mock.calls[0][0].filename).toBe('small.pdf');

      expect(result!.parts).toHaveLength(3);
      expect(result!.parts![0].text).toBe('[Uploaded Artifact: "small.pdf"]');
      expect(result!.parts![1].fileData!.fileUri).toBe(
        'gs://mock-bucket/small.pdf/versions/0',
      );
      expect(result!.parts![2].text).toBe(
        '[Upload Error: File large.pdf (25.00 MB) exceeds the maximum' +
          ' supported size of 20MB. Please upload a smaller file.]',
      );
    });
  });
});
