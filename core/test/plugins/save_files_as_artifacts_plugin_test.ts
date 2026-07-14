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
} from '@google/adk';
import {Blob, Content, Part} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

describe('SaveFilesAsArtifactsPlugin', () => {
  let plugin: SaveFilesAsArtifactsPlugin;
  let mockContext: InvocationContext;
  let mockSession: {
    id: string;
    appName: string;
    userId: string;
    state: Record<string, unknown>;
  };
  let mockArtifactService: {
    saveArtifact: ReturnType<typeof vi.fn>;
    getArtifactVersion: ReturnType<typeof vi.fn>;
    loadArtifact: ReturnType<typeof vi.fn>;
    listArtifactKeys: ReturnType<typeof vi.fn>;
    deleteArtifact: ReturnType<typeof vi.fn>;
    listVersions: ReturnType<typeof vi.fn>;
    listArtifactVersions: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    plugin = new SaveFilesAsArtifactsPlugin();

    mockArtifactService = {
      saveArtifact: vi.fn().mockResolvedValue(0),
      getArtifactVersion: vi
        .fn()
        .mockImplementation(
          async ({filename, version}: {filename: string; version: number}) => {
            return {
              version: version ?? 0,
              canonicalUri: `gs://mock-bucket/${filename}/versions/${version ?? 0}`,
              mimeType: 'application/pdf',
            } as ArtifactVersion;
          },
        ),
      loadArtifact: vi.fn(),
      listArtifactKeys: vi.fn(),
      deleteArtifact: vi.fn(),
      listVersions: vi.fn(),
      listArtifactVersions: vi.fn(),
    };

    mockSession = {
      id: 'test_session',
      appName: 'test_app',
      userId: 'test_user',
      state: {},
    };

    mockContext = {
      appName: 'test_app',
      userId: 'test_user',
      invocationId: 'test_invocation_123',
      session: mockSession,
      artifactService: mockArtifactService,
    } as unknown as InvocationContext;
  });

  it('should save files when inlineData has displayName', async () => {
    const inlineData: Blob = {
      displayName: 'test_document.pdf',
      data: 'dGVzdCBkYXRh',
      mimeType: 'application/pdf',
    };

    const originalPart: Part = {inlineData};
    const userMessage: Content = {parts: [originalPart]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(mockArtifactService.saveArtifact).toHaveBeenCalledTimes(1);
    expect(mockArtifactService.saveArtifact).toHaveBeenCalledWith({
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

  it('should not attach file reference when attachFileReference is false', async () => {
    const pluginNoRef = new SaveFilesAsArtifactsPlugin(undefined, {
      attachFileReference: false,
    });

    const inlineData: Blob = {
      displayName: 'test_document.pdf',
      data: 'dGVzdCBkYXRh',
      mimeType: 'application/pdf',
    };

    const originalPart: Part = {inlineData};
    const userMessage: Content = {parts: [originalPart]};

    const result = await pluginNoRef.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(mockArtifactService.saveArtifact).toHaveBeenCalledTimes(1);
    expect(mockArtifactService.saveArtifact).toHaveBeenCalledWith({
      filename: 'test_document.pdf',
      artifact: originalPart,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(1);
    expect(result!.parts![0].text).toBe(
      '[Uploaded Artifact: "test_document.pdf"]',
    );
  });

  it('should save files with generated filename when inlineData has no displayName', async () => {
    const inlineData: Blob = {
      displayName: undefined,
      data: 'dGVzdCBkYXRh',
      mimeType: 'application/pdf',
    };

    const originalPart: Part = {inlineData};
    const userMessage: Content = {parts: [originalPart]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    const expectedFilename = 'artifact_test_invocation_123_0';
    expect(mockArtifactService.saveArtifact).toHaveBeenCalledTimes(1);
    expect(mockArtifactService.saveArtifact).toHaveBeenCalledWith({
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

  it('should handle multiple files in a single message', async () => {
    const inlineData1: Blob = {
      displayName: 'file1.txt',
      data: 'ZmlsZTEgY29udGVudA==',
      mimeType: 'text/plain',
    };
    const inlineData2: Blob = {
      displayName: 'file2.jpg',
      data: 'ZmlsZTIgY29udGVudA==',
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

    expect(mockArtifactService.saveArtifact).toHaveBeenCalledTimes(2);
    expect(mockArtifactService.saveArtifact).toHaveBeenNthCalledWith(1, {
      filename: 'file1.txt',
      artifact: {inlineData: inlineData1},
    });
    expect(mockArtifactService.saveArtifact).toHaveBeenNthCalledWith(2, {
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

  it('should return undefined when artifactService is not set', async () => {
    (mockContext as unknown as Record<string, unknown>).artifactService =
      undefined;

    const inlineData: Blob = {
      displayName: 'test.pdf',
      data: 'dGVzdCBkYXRh',
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeUndefined();
  });

  it('should return undefined when message has no parts', async () => {
    const userMessage: Content = {parts: []};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeUndefined();
    expect(mockArtifactService.saveArtifact).not.toHaveBeenCalled();
  });

  it('should return undefined when parts do not have inlineData', async () => {
    const userMessage: Content = {
      parts: [{text: 'Hello world'}, {text: 'No files here'}],
    };

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeUndefined();
    expect(mockArtifactService.saveArtifact).not.toHaveBeenCalled();
  });

  it('should keep original part when saving artifact fails', async () => {
    mockArtifactService.saveArtifact.mockRejectedValue(
      new Error('Storage error'),
    );

    const inlineData: Blob = {
      displayName: 'test.pdf',
      data: 'dGVzdCBkYXRh',
      mimeType: 'application/pdf',
    };
    const userMessage: Content = {parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeUndefined();
  });

  it('should handle multi-part message where some saves succeed and others fail', async () => {
    let callCount = 0;
    mockArtifactService.saveArtifact.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error('Storage error on second file');
      }
      return 0;
    });

    const inlineData1: Blob = {
      displayName: 'success.pdf',
      data: 'c3VjY2VzcyBkYXRh',
      mimeType: 'application/pdf',
    };
    const inlineData2: Blob = {
      displayName: 'failure.pdf',
      data: 'ZmFpbHVyZSBkYXRh',
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
    expect(result!.parts![2]).toBe(originalPart2);
    expect(result!.parts![2].inlineData).toBe(inlineData2);
  });

  it('should format placeholder text correctly', async () => {
    const inlineData: Blob = {
      displayName: 'test file with spaces.docx',
      data: 'ZG9jdW1lbnQgZGF0YQ==',
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

  it('should initialize with default plugin name', () => {
    const defaultPlugin = new SaveFilesAsArtifactsPlugin();
    expect(defaultPlugin.name).toBe('save_files_as_artifacts_plugin');
  });

  it('should record pending delta in state and merge into actions across turns', async () => {
    const blob1: Blob = {
      displayName: 'blob.pdf',
      data: 'dGVzdCBkYXRh',
      mimeType: 'application/pdf',
    };
    await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage: {parts: [{inlineData: blob1}]},
    });

    const key = 'save_files_as_artifacts_plugin:pendingDelta';
    expect(mockContext.session.state[key]).toEqual({'blob.pdf': 0});

    const callbackContext1 = new Context({
      invocationContext: mockContext,
      eventActions: createEventActions(),
    });

    await plugin.beforeAgentCallback({
      agent: {} as BaseAgent,
      callbackContext: callbackContext1,
    });

    expect(callbackContext1.actions.artifactDelta).toEqual({'blob.pdf': 0});
    expect(mockContext.session.state[key]).toEqual({});

    const blob2: Blob = {
      displayName: 'blob_2.pdf',
      data: 'dGVzdCBkYXRhIDI=',
      mimeType: 'application/pdf',
    };
    await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage: {parts: [{inlineData: blob2}]},
    });

    expect(mockContext.session.state[key]).toEqual({'blob_2.pdf': 0});

    const callbackContext2 = new Context({
      invocationContext: mockContext,
      eventActions: createEventActions(),
    });

    await plugin.beforeAgentCallback({
      agent: {} as BaseAgent,
      callbackContext: callbackContext2,
    });

    expect(callbackContext2.actions.artifactDelta).toEqual({'blob_2.pdf': 0});
    expect(mockContext.session.state[key]).toEqual({});
  });

  it('should not attach fileData when URI scheme is not model accessible', async () => {
    mockArtifactService.getArtifactVersion.mockResolvedValue({
      version: 0,
      canonicalUri: 'file:///local/path/test.pdf',
      mimeType: 'application/pdf',
    });

    const inlineData: Blob = {
      displayName: 'test.pdf',
      data: 'dGVzdCBkYXRh',
      mimeType: 'application/pdf',
    };

    const userMessage: Content = {parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(1);
    expect(result!.parts![0].text).toBe('[Uploaded Artifact: "test.pdf"]');
    expect(result!.parts![0].fileData).toBeUndefined();
  });

  it('should not attach fileData when getArtifactVersion throws an error', async () => {
    mockArtifactService.getArtifactVersion.mockRejectedValue(
      new Error('Resolution failure'),
    );

    const inlineData: Blob = {
      displayName: 'test.pdf',
      data: 'dGVzdCBkYXRh',
      mimeType: 'application/pdf',
    };

    const userMessage: Content = {parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result).toBeDefined();
    expect(result!.parts).toHaveLength(1);
    expect(result!.parts![0].text).toBe('[Uploaded Artifact: "test.pdf"]');
    expect(result!.parts![0].fileData).toBeUndefined();
  });

  it('should not attach fileData when getArtifactVersion returns undefined or no canonicalUri', async () => {
    mockArtifactService.getArtifactVersion.mockResolvedValue(undefined);

    const inlineData: Blob = {
      displayName: 'test.pdf',
      data: 'dGVzdCBkYXRh',
      mimeType: 'application/pdf',
    };

    const userMessage: Content = {parts: [{inlineData}]};

    const result1 = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });
    expect(result1!.parts).toHaveLength(1);

    mockArtifactService.getArtifactVersion.mockResolvedValue({
      version: 0,
      canonicalUri: undefined,
    });

    const result2 = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });
    expect(result2!.parts).toHaveLength(1);
  });

  it('should not attach fileData when canonicalUri is not a valid URL', async () => {
    mockArtifactService.getArtifactVersion.mockResolvedValue({
      version: 0,
      canonicalUri: 'not a valid url',
      mimeType: 'application/pdf',
    });

    const inlineData: Blob = {
      displayName: 'test.pdf',
      data: 'dGVzdCBkYXRh',
      mimeType: 'application/pdf',
    };

    const userMessage: Content = {parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result!.parts).toHaveLength(1);
    expect(result!.parts![0].fileData).toBeUndefined();
  });

  it('should fallback to artifactVersion.mimeType when inlineData.mimeType is undefined', async () => {
    mockArtifactService.getArtifactVersion.mockResolvedValue({
      version: 0,
      canonicalUri: 'gs://mock-bucket/test.pdf/versions/0',
      mimeType: 'application/x-fallback-pdf',
    });

    const inlineData: Blob = {
      displayName: 'test.pdf',
      data: 'dGVzdCBkYXRh',
      mimeType: undefined,
    };

    const userMessage: Content = {parts: [{inlineData}]};

    const result = await plugin.onUserMessageCallback({
      invocationContext: mockContext,
      userMessage,
    });

    expect(result!.parts).toHaveLength(2);
    expect(result!.parts![1].fileData!.mimeType).toBe(
      'application/x-fallback-pdf',
    );
  });

  it('should do nothing in beforeAgentCallback when pendingDelta is not set or not an object', async () => {
    const callbackContext = new Context({
      invocationContext: mockContext,
      eventActions: createEventActions(),
    });

    // When pendingDelta is undefined
    await plugin.beforeAgentCallback({
      agent: {} as BaseAgent,
      callbackContext,
    });
    expect(callbackContext.actions.artifactDelta).toEqual({});

    // When pendingDelta is not an object
    mockContext.session.state[`${plugin.name}:pendingDelta`] = 'invalid string';
    const callbackContext2 = new Context({
      invocationContext: mockContext,
      eventActions: createEventActions(),
    });
    await plugin.beforeAgentCallback({
      agent: {} as BaseAgent,
      callbackContext: callbackContext2,
    });
    expect(callbackContext2.actions.artifactDelta).toEqual({});
  });
});
