/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ArtifactVersion,
  BaseAgent,
  Context,
  createEventActions,
  InvocationContext,
  SaveFilesAsArtifactsPlugin,
  Session,
  SessionArtifactService,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

describe('SaveFilesAsArtifactsPlugin', () => {
  let plugin: SaveFilesAsArtifactsPlugin;
  let mockInvocationContext: InvocationContext;
  let mockArtifactService: vi.Mocked<SessionArtifactService>;
  let mockSession: Session;

  beforeEach(() => {
    plugin = new SaveFilesAsArtifactsPlugin();

    mockArtifactService = {
      saveArtifact: vi.fn().mockResolvedValue(0),
      loadArtifact: vi.fn(),
      listArtifactKeys: vi.fn(),
      deleteArtifact: vi.fn(),
      listVersions: vi.fn(),
      listArtifactVersions: vi.fn(),
      getArtifactVersion: vi
        .fn()
        .mockImplementation(async ({filename, version}) => ({
          version: version || 0,
          canonicalUri: `gs://mock-bucket/${filename}/versions/${version || 0}`,
          mimeType: 'application/pdf',
        })),
    } as unknown as vi.Mocked<SessionArtifactService>;

    mockSession = {
      id: 'test_session',
      userId: 'test_user',
      appName: 'test_app',
      events: [],
      state: {},
      lastUpdateTime: Date.now(),
    } as unknown as Session;

    mockInvocationContext = {
      appName: 'test_app',
      userId: 'test_user',
      invocationId: 'test_invocation_123',
      session: mockSession,
      artifactService: mockArtifactService,
    } as unknown as InvocationContext;
  });

  it('should initialize with correct default and custom names and options', () => {
    expect(plugin.name).toBe('save_files_as_artifacts_plugin');
    expect(plugin.attachFileReference).toBe(true);

    const customPlugin = new SaveFilesAsArtifactsPlugin({
      name: 'custom_name',
      attachFileReference: false,
    });
    expect(customPlugin.name).toBe('custom_name');
    expect(customPlugin.attachFileReference).toBe(false);
  });

  it('should save files when inlineData has valid displayName', async () => {
    const inlinePart: Part = {
      inlineData: {
        displayName: 'test_document.pdf',
        data: 'dGVzdCBkYXRh',
        mimeType: 'application/pdf',
      },
    };
    const userMessage: Content = {role: 'user', parts: [inlinePart]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage,
    });

    expect(mockArtifactService.saveArtifact).toHaveBeenCalledOnce();
    expect(mockArtifactService.saveArtifact).toHaveBeenCalledWith({
      filename: 'test_document.pdf',
      artifact: inlinePart,
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

  it('should save files when inlineData uses snake_case display_name', async () => {
    const inlinePart: Part = {
      inlineData: {
        display_name: 'snake_document.pdf',
        data: 'dGVzdCBkYXRh',
        mimeType: 'application/pdf',
      } as unknown as Part['inlineData'],
    };
    const userMessage: Content = {role: 'user', parts: [inlinePart]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage,
    });

    expect(mockArtifactService.saveArtifact).toHaveBeenCalledWith(
      expect.objectContaining({filename: 'snake_document.pdf'}),
    );
    expect(result!.parts![0].text).toBe(
      '[Uploaded Artifact: "snake_document.pdf"]',
    );
  });

  it('should save files with generated filename when inlineData has no displayName', async () => {
    const inlinePart: Part = {
      inlineData: {
        data: 'dGVzdCBkYXRh',
        mimeType: 'application/pdf',
      },
    };
    const userMessage: Content = {role: 'user', parts: [inlinePart]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage,
    });

    const expectedFilename = 'artifact_test_invocation_123_0';
    expect(mockArtifactService.saveArtifact).toHaveBeenCalledWith({
      filename: expectedFilename,
      artifact: inlinePart,
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

  it('should not attach file reference when attachFileReference is false', async () => {
    const noRefPlugin = new SaveFilesAsArtifactsPlugin({
      attachFileReference: false,
    });
    const inlinePart: Part = {
      inlineData: {
        displayName: 'test_document.pdf',
        data: 'dGVzdCBkYXRh',
        mimeType: 'application/pdf',
      },
    };
    const userMessage: Content = {role: 'user', parts: [inlinePart]};

    const result = await noRefPlugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage,
    });

    expect(result!.parts).toHaveLength(1);
    expect(result!.parts![0].text).toBe(
      '[Uploaded Artifact: "test_document.pdf"]',
    );
  });

  it('should handle multiple files and text parts in a single message', async () => {
    const inline1: Part = {
      inlineData: {
        displayName: 'file1.txt',
        data: 'MTIz',
        mimeType: 'text/plain',
      },
    };
    const textPart: Part = {text: 'middle text'};
    const inline2: Part = {
      inlineData: {
        displayName: 'file2.jpg',
        data: 'NDU2',
        mimeType: 'image/jpeg',
      },
    };
    const userMessage: Content = {
      role: 'user',
      parts: [inline1, textPart, inline2],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage,
    });

    expect(mockArtifactService.saveArtifact).toHaveBeenCalledTimes(2);
    expect(result!.parts).toHaveLength(5);
    expect(result!.parts![0].text).toBe('[Uploaded Artifact: "file1.txt"]');
    expect(result!.parts![1].fileData!.fileUri).toBe(
      'gs://mock-bucket/file1.txt/versions/0',
    );
    expect(result!.parts![2].text).toBe('middle text');
    expect(result!.parts![3].text).toBe('[Uploaded Artifact: "file2.jpg"]');
    expect(result!.parts![4].fileData!.fileUri).toBe(
      'gs://mock-bucket/file2.jpg/versions/0',
    );
  });

  it('should return undefined and log warning when artifactService is undefined', async () => {
    const contextWithoutService = {
      ...mockInvocationContext,
      artifactService: undefined,
    } as unknown as InvocationContext;

    const userMessage: Content = {
      role: 'user',
      parts: [{inlineData: {data: 'abc', mimeType: 'text/plain'}}],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: contextWithoutService,
      userMessage,
    });

    expect(result).toBeUndefined();
  });

  it('should return undefined when message has no parts or empty parts array', async () => {
    expect(
      await plugin.onUserMessageCallback({
        invocationContext: mockInvocationContext,
        userMessage: {role: 'user', parts: []},
      }),
    ).toBeUndefined();

    expect(
      await plugin.onUserMessageCallback({
        invocationContext: mockInvocationContext,
        userMessage: {role: 'user'} as Content,
      }),
    ).toBeUndefined();
  });

  it('should return undefined when parts do not contain inlineData', async () => {
    const userMessage: Content = {
      role: 'user',
      parts: [{text: 'hello'}, {fileData: {fileUri: 'gs://foo/bar'}}],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage,
    });

    expect(result).toBeUndefined();
    expect(mockArtifactService.saveArtifact).not.toHaveBeenCalled();
  });

  it('should handle saveArtifact exceptions gracefully by retaining original part', async () => {
    mockArtifactService.saveArtifact.mockRejectedValueOnce(
      new Error('Storage error'),
    );

    const inlinePart: Part = {
      inlineData: {
        displayName: 'error.pdf',
        data: 'abc',
        mimeType: 'application/pdf',
      },
    };
    const userMessage: Content = {role: 'user', parts: [inlinePart]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage,
    });

    expect(result).toBeUndefined();
  });

  it('should handle partial saveArtifact failures across multiple parts', async () => {
    mockArtifactService.saveArtifact
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('Storage error 2'));

    const inline1: Part = {
      inlineData: {
        displayName: 'success.pdf',
        data: 'abc',
        mimeType: 'application/pdf',
      },
    };
    const inline2: Part = {
      inlineData: {
        displayName: 'failure.pdf',
        data: 'def',
        mimeType: 'application/pdf',
      },
    };
    const userMessage: Content = {role: 'user', parts: [inline1, inline2]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage,
    });

    expect(result!.parts).toHaveLength(3);
    expect(result!.parts![0].text).toBe('[Uploaded Artifact: "success.pdf"]');
    expect(result!.parts![1].fileData).toBeDefined();
    expect(result!.parts![2]).toEqual(inline2);
  });

  it('should omit file reference when getArtifactVersion fails or returns inaccessible URI', async () => {
    // Case 1: getArtifactVersion rejects
    mockArtifactService.getArtifactVersion.mockRejectedValueOnce(
      new Error('Version fetch failed'),
    );

    const part1: Part = {
      inlineData: {
        displayName: 'file1.pdf',
        data: 'abc',
        mimeType: 'application/pdf',
      },
    };
    const res1 = await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage: {role: 'user', parts: [part1]},
    });
    expect(res1!.parts).toHaveLength(1);
    expect(res1!.parts![0].text).toBe('[Uploaded Artifact: "file1.pdf"]');

    // Case 2: getArtifactVersion returns undefined
    mockArtifactService.getArtifactVersion.mockResolvedValueOnce(undefined);
    const res2 = await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage: {role: 'user', parts: [part1]},
    });
    expect(res2!.parts).toHaveLength(1);

    // Case 3: getArtifactVersion returns version without canonicalUri
    mockArtifactService.getArtifactVersion.mockResolvedValueOnce({
      version: 0,
    } as ArtifactVersion);
    const res3 = await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage: {role: 'user', parts: [part1]},
    });
    expect(res3!.parts).toHaveLength(1);

    // Case 4: canonicalUri has non-model-accessible scheme (e.g. ftp:// or invalid url)
    mockArtifactService.getArtifactVersion.mockResolvedValueOnce({
      version: 0,
      canonicalUri: 'ftp://server/file.pdf',
    });
    const res4 = await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage: {role: 'user', parts: [part1]},
    });
    expect(res4!.parts).toHaveLength(1);

    // Case 5: canonicalUri is not a valid URL
    mockArtifactService.getArtifactVersion.mockResolvedValueOnce({
      version: 0,
      canonicalUri: 'not_a_url',
    });
    const res5 = await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage: {role: 'user', parts: [part1]},
    });
    expect(res5!.parts).toHaveLength(1);

    // Case 6: canonicalUri uses http/https/gs scheme
    mockArtifactService.getArtifactVersion.mockResolvedValueOnce({
      version: 0,
      canonicalUri: 'https://storage.example.com/file1.pdf',
      mimeType: 'application/pdf',
    });
    const res6 = await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage: {role: 'user', parts: [part1]},
    });
    expect(res6!.parts).toHaveLength(2);
    expect(res6!.parts![1].fileData!.fileUri).toBe(
      'https://storage.example.com/file1.pdf',
    );
  });

  it('should transfer pending_delta to callbackContext.actions.artifactDelta in beforeAgentCallback and clear state', async () => {
    // Step 1: onUserMessageCallback stores pending_delta in session.state
    const inlinePart: Part = {
      inlineData: {
        displayName: 'doc.pdf',
        data: 'abc',
        mimeType: 'application/pdf',
      },
    };
    await plugin.onUserMessageCallback({
      invocationContext: mockInvocationContext,
      userMessage: {role: 'user', parts: [inlinePart]},
    });

    const key = 'save_files_as_artifacts_plugin:pending_delta';
    expect(mockSession.state[key]).toEqual({'doc.pdf': 0});

    // Step 2: beforeAgentCallback transfers to actions.artifactDelta
    const mockCallbackContext = {
      state: {
        get: (k: string) => mockSession.state[k],
      },
      actions: createEventActions({artifactDelta: {}}),
      invocationContext: mockInvocationContext,
    } as unknown as Context;

    await plugin.beforeAgentCallback({
      agent: {} as BaseAgent,
      callbackContext: mockCallbackContext,
    });

    expect(mockCallbackContext.actions.artifactDelta).toEqual({'doc.pdf': 0});
    expect(mockSession.state[key]).toBeUndefined();
  });

  it('should do nothing in beforeAgentCallback if pending_delta is not present or empty', async () => {
    const mockCallbackContext = {
      state: {
        get: () => undefined,
      },
      actions: createEventActions({artifactDelta: {existing: 1}}),
      invocationContext: mockInvocationContext,
    } as unknown as Context;

    await plugin.beforeAgentCallback({
      agent: {} as BaseAgent,
      callbackContext: mockCallbackContext,
    });

    expect(mockCallbackContext.actions.artifactDelta).toEqual({existing: 1});

    // Also test empty dict
    const emptyCallbackContext = {
      state: {
        get: () => ({}),
      },
      actions: createEventActions({artifactDelta: {existing: 1}}),
      invocationContext: mockInvocationContext,
    } as unknown as Context;

    await plugin.beforeAgentCallback({
      agent: {} as BaseAgent,
      callbackContext: emptyCallbackContext,
    });

    expect(emptyCallbackContext.actions.artifactDelta).toEqual({existing: 1});
  });

  it('should fallback to artifactVersion.mimeType and filename in buildFileReferencePart when parameters are undefined', async () => {
    mockArtifactService.getArtifactVersion.mockResolvedValueOnce({
      version: 0,
      canonicalUri: 'gs://mock-bucket/fallback.pdf/versions/0',
      mimeType: 'image/png',
    });

    const res = await (
      plugin as unknown as {
        buildFileReferencePart(
          ctx: InvocationContext,
          filename: string,
          version: number,
          mimeType?: string,
        ): Promise<Part | undefined>;
      }
    ).buildFileReferencePart(
      mockInvocationContext,
      'fallback.pdf',
      0,
      undefined,
    );

    expect(res).toBeDefined();
    expect(res!.fileData!.mimeType).toBe('image/png');
    expect(res!.fileData!.displayName).toBe('fallback.pdf');
  });

  it('should fallback to empty string mimeType in buildFileReferencePart when both parameter and artifactVersion.mimeType are undefined', async () => {
    mockArtifactService.getArtifactVersion.mockResolvedValueOnce({
      version: 0,
      canonicalUri: 'gs://mock-bucket/nomime.pdf/versions/0',
      mimeType: undefined,
    });

    const res = await (
      plugin as unknown as {
        buildFileReferencePart(
          ctx: InvocationContext,
          filename: string,
          version: number,
          mimeType?: string,
        ): Promise<Part | undefined>;
      }
    ).buildFileReferencePart(mockInvocationContext, 'nomime.pdf', 0, undefined);

    expect(res).toBeDefined();
    expect(res!.fileData!.mimeType).toBe('');
  });
});
