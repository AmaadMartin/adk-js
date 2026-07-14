/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ArtifactVersion,
  Context,
  createEventActions,
  createSession,
  InvocationContext,
  SaveFilesAsArtifactsPlugin,
  SessionArtifactService,
} from '@google/adk';
import {Blob, Content, Part} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

describe('SaveFilesAsArtifactsPlugin', () => {
  let plugin: SaveFilesAsArtifactsPlugin;
  let mockContext: InvocationContext;
  let mockArtifactService: SessionArtifactService;
  let mockSaveArtifact: vi.Mock;
  let mockGetArtifactVersion: vi.Mock;

  beforeEach(() => {
    plugin = new SaveFilesAsArtifactsPlugin();

    mockSaveArtifact = vi.fn().mockResolvedValue(0);
    mockGetArtifactVersion = vi.fn().mockImplementation(async (req) => {
      const filename = req.filename ?? 'unknown_file';
      const version = req.version ?? 0;
      return {
        version,
        canonicalUri: `gs://mock-bucket/${filename}/versions/${version}`,
        mimeType: 'application/pdf',
      } as ArtifactVersion;
    });

    mockArtifactService = {
      saveArtifact: mockSaveArtifact,
      getArtifactVersion: mockGetArtifactVersion,
      loadArtifact: vi.fn(),
      listArtifactKeys: vi.fn(),
      deleteArtifact: vi.fn(),
      listVersions: vi.fn(),
      listArtifactVersions: vi.fn(),
    };

    mockContext = {
      appName: 'test_app',
      userId: 'test_user',
      invocationId: 'test_invocation_123',
      session: createSession({
        id: 'test_session',
        appName: 'test_app',
        userId: 'test_user',
        state: {},
      }),
      artifactService: mockArtifactService,
    } as unknown as InvocationContext;
  });

  it('testSaveFilesWithDisplayName', async () => {
    const inlineData: Blob = {
      displayName: 'test_document.pdf',
      data: 'test data',
      mimeType: 'application/pdf',
    };

    const originalPart: Part = {inlineData};
    const userMessage: Content = {parts: [originalPart]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(mockSaveArtifact).toHaveBeenCalledTimes(1);
    expect(mockSaveArtifact).toHaveBeenCalledWith({
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

  it('testAttachFileReferenceFalse', async () => {
    const customPlugin = new SaveFilesAsArtifactsPlugin({
      attachFileReference: false,
    });

    const inlineData: Blob = {
      displayName: 'test_document.pdf',
      data: 'test data',
      mimeType: 'application/pdf',
    };

    const originalPart: Part = {inlineData};
    const userMessage: Content = {parts: [originalPart]};

    const result = await customPlugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(mockSaveArtifact).toHaveBeenCalledTimes(1);
    expect(mockSaveArtifact).toHaveBeenCalledWith({
      filename: 'test_document.pdf',
      artifact: originalPart,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(1);
    expect(result!.parts![0].text).toBe(
      '[Uploaded Artifact: "test_document.pdf"]',
    );
  });

  it('testSaveFilesWithoutDisplayName', async () => {
    const inlineData: Blob = {
      displayName: undefined,
      data: 'test data',
      mimeType: 'application/pdf',
    };

    const originalPart: Part = {inlineData};
    const userMessage: Content = {parts: [originalPart]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    const expectedFilename = 'artifact_test_invocation_123_0';
    expect(mockSaveArtifact).toHaveBeenCalledTimes(1);
    expect(mockSaveArtifact).toHaveBeenCalledWith({
      filename: expectedFilename,
      artifact: originalPart,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(2);
    expect(result!.parts![0].text).toBe(
      `[Uploaded Artifact: "${expectedFilename}"]`,
    );
    expect(result!.parts![1].fileData).toBeDefined();
    expect(result!.parts![1].fileData!.fileUri).toBe(
      `gs://mock-bucket/${expectedFilename}/versions/0`,
    );
    expect(result!.parts![1].fileData!.displayName).toBe(expectedFilename);
  });

  it('testMultipleFilesInMessage', async () => {
    const inlineData1: Blob = {
      displayName: 'file1.txt',
      data: 'file1 content',
      mimeType: 'text/plain',
    };
    const inlineData2: Blob = {
      displayName: 'file2.jpg',
      data: 'file2 content',
      mimeType: 'image/jpeg',
    };

    const userMessage: Content = {
      parts: [
        {inlineData: inlineData1},
        {text: 'Some text between files'},
        {inlineData: inlineData2},
      ],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(mockSaveArtifact).toHaveBeenCalledTimes(2);
    expect(mockSaveArtifact).toHaveBeenNthCalledWith(1, {
      filename: 'file1.txt',
      artifact: {inlineData: inlineData1},
    });
    expect(mockSaveArtifact).toHaveBeenNthCalledWith(2, {
      filename: 'file2.jpg',
      artifact: {inlineData: inlineData2},
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(5);
    expect(result!.parts![0].text).toBe('[Uploaded Artifact: "file1.txt"]');
    expect(result!.parts![1].fileData).toBeDefined();
    expect(result!.parts![1].fileData!.fileUri).toBe(
      'gs://mock-bucket/file1.txt/versions/0',
    );
    expect(result!.parts![1].fileData!.displayName).toBe('file1.txt');
    expect(result!.parts![2].text).toBe('Some text between files');
    expect(result!.parts![3].text).toBe('[Uploaded Artifact: "file2.jpg"]');
    expect(result!.parts![4].fileData).toBeDefined();
    expect(result!.parts![4].fileData!.fileUri).toBe(
      'gs://mock-bucket/file2.jpg/versions/0',
    );
    expect(result!.parts![4].fileData!.displayName).toBe('file2.jpg');
  });

  it('testNoArtifactService', async () => {
    const contextWithoutService = {
      ...mockContext,
      artifactService: undefined,
    } as unknown as InvocationContext;

    const inlineData: Blob = {
      displayName: 'test.pdf',
      data: 'test data',
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: contextWithoutService,
      userMessage,
    });

    expect(result).toEqual(userMessage);
    expect(result!.parts![0].inlineData).toEqual(inlineData);
  });

  it('testNoPartsInMessage', async () => {
    const userMessage: Content = {parts: []};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeUndefined();
    expect(mockSaveArtifact).not.toHaveBeenCalled();
  });

  it('testPartsWithoutInlineData', async () => {
    const userMessage: Content = {
      parts: [{text: 'Hello world'}, {text: 'No files here'}],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeUndefined();
    expect(mockSaveArtifact).not.toHaveBeenCalled();
  });

  it('testSaveArtifactFailure', async () => {
    mockSaveArtifact.mockRejectedValue(new Error('Storage error'));

    const inlineData: Blob = {
      displayName: 'test.pdf',
      data: 'test data',
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeUndefined();
  });

  it('testMixedSuccessAndFailure', async () => {
    let saveCalls = 0;
    mockSaveArtifact.mockImplementation(async () => {
      saveCalls++;
      if (saveCalls === 2) {
        throw new Error('Storage error on second file');
      }
      return 0;
    });

    const inlineData1: Blob = {
      displayName: 'success.pdf',
      data: 'success data',
      mimeType: 'application/pdf',
    };
    const inlineData2: Blob = {
      displayName: 'failure.pdf',
      data: 'failure data',
      mimeType: 'application/pdf',
    };

    const originalPart2: Part = {inlineData: inlineData2};
    const userMessage: Content = {
      parts: [{inlineData: inlineData1}, originalPart2],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(3);
    expect(result!.parts![0].text).toBe('[Uploaded Artifact: "success.pdf"]');
    expect(result!.parts![1].fileData).toBeDefined();
    expect(result!.parts![2]).toEqual(originalPart2);
    expect(result!.parts![2].inlineData).toEqual(inlineData2);
  });

  it('testPlaceholderTextFormat', async () => {
    const inlineData: Blob = {
      displayName: 'test file with spaces.docx',
      data: 'document data',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };

    const userMessage: Content = {parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    const expectedText = '[Uploaded Artifact: "test file with spaces.docx"]';
    expect(result!.parts![0].text).toBe(expectedText);
    expect(result!.parts![1].fileData).toBeDefined();
  });

  it('testPluginNameDefault', () => {
    const defaultPlugin = new SaveFilesAsArtifactsPlugin();
    expect(defaultPlugin.name).toBe('save_files_as_artifacts_plugin');

    const customPlugin = new SaveFilesAsArtifactsPlugin({
      name: 'my_custom_plugin',
    });
    expect(customPlugin.name).toBe('my_custom_plugin');
  });

  it('testArtifactDeltaReporting', async () => {
    // 1. First Turn - Trigger user message callback
    const blob: Blob = {
      displayName: 'blob.pdf',
      data: 'test data',
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {parts: [{inlineData: blob}]};
    await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    // Verify state is updated
    const key = 'save_files_as_artifacts_plugin:pending_delta';
    expect(mockContext.session.state[key]).toEqual({'blob.pdf': 0});

    // 2. First Turn - Trigger before agent callback
    const actions = createEventActions();
    const callbackContext = new Context({
      invocationContext: mockContext,
      eventActions: actions,
    });
    await plugin.beforeAgentCallback({
      agent: mockContext.agent,
      callbackContext,
    });

    // Verify artifactDelta is updated and state is cleared
    expect(actions.artifactDelta).toEqual({'blob.pdf': 0});
    expect(mockContext.session.state[key]).toEqual({});

    // 3. Second Turn - Trigger user message callback
    const blob2: Blob = {
      displayName: 'blob_2.pdf',
      data: 'test data 2',
      mimeType: 'application/pdf',
    };
    const userMessage2: Content = {parts: [{inlineData: blob2}]};
    await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage: userMessage2,
    });

    // Verify state is updated
    expect(mockContext.session.state[key]).toEqual({'blob_2.pdf': 0});

    // 4. Second Turn - Trigger before agent callback
    const actions2 = createEventActions();
    const callbackContext2 = new Context({
      invocationContext: mockContext,
      eventActions: actions2,
    });
    await plugin.beforeAgentCallback({
      agent: mockContext.agent,
      callbackContext: callbackContext2,
    });

    // Verify artifactDelta is updated and state is cleared
    expect(actions2.artifactDelta).toEqual({'blob_2.pdf': 0});
    expect(mockContext.session.state[key]).toEqual({});
  });

  it('handles getArtifactVersion failure cleanly', async () => {
    mockGetArtifactVersion.mockRejectedValue(new Error('Resolve failure'));

    const inlineData: Blob = {
      displayName: 'failing_resolve.pdf',
      data: 'test data',
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(1);
    expect(result!.parts![0].text).toBe(
      '[Uploaded Artifact: "failing_resolve.pdf"]',
    );
  });

  it('handles non-model-accessible URI schemes without building fileData part', async () => {
    mockGetArtifactVersion.mockImplementation(async (req) => {
      return {
        version: req.version ?? 0,
        canonicalUri: 's3://unsupported-bucket/file.pdf',
        mimeType: 'application/pdf',
      } as ArtifactVersion;
    });

    const inlineData: Blob = {
      displayName: 's3_file.pdf',
      data: 'test data',
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(1);
    expect(result!.parts![0].text).toBe('[Uploaded Artifact: "s3_file.pdf"]');
  });

  it('handles invalid URL format in canonicalUri cleanly', async () => {
    mockGetArtifactVersion.mockImplementation(async (req) => {
      return {
        version: req.version ?? 0,
        canonicalUri: 'invalid-url-string-without-protocol',
        mimeType: 'application/pdf',
      } as ArtifactVersion;
    });

    const inlineData: Blob = {
      displayName: 'invalid_url.pdf',
      data: 'test data',
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(1);
    expect(result!.parts![0].text).toBe(
      '[Uploaded Artifact: "invalid_url.pdf"]',
    );
  });

  it('uses artifactVersion.mimeType when inlineData.mimeType is undefined', async () => {
    const inlineData: Blob = {
      displayName: 'no_mime.pdf',
      data: 'test data',
      mimeType: undefined,
    };
    const userMessage: Content = {parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(2);
    expect(result!.parts![1].fileData!.mimeType).toBe('application/pdf');
  });
});
