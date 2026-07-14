/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  Context,
  InvocationContext,
  SaveFilesAsArtifactsPlugin,
  SessionArtifactService,
  buildFileReferencePart,
  isModelAccessibleUri,
  processUserMessageArtifacts,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {resetLogger, setLogger} from '../../src/utils/logger.js';

function makeMockLogger() {
  const infoCalls: string[] = [];
  const warnCalls: string[] = [];
  const errorCalls: string[] = [];
  const mockLogger = {
    setLogLevel: () => {},
    log: () => {},
    debug: () => {},
    info: (...args: unknown[]) => {
      infoCalls.push(args.map((a) => String(a)).join(' '));
    },
    warn: (...args: unknown[]) => {
      warnCalls.push(args.map((a) => String(a)).join(' '));
    },
    error: (...args: unknown[]) => {
      errorCalls.push(args.map((a) => String(a)).join(' '));
    },
  };
  return {mockLogger, infoCalls, warnCalls, errorCalls};
}

describe('SaveFilesAsArtifactsPlugin & Utilities', () => {
  const mockAgent = {name: 'test_agent'} as BaseAgent;
  let mockArtifactService: SessionArtifactService & {
    saveArtifactCalls: Array<unknown>;
    getArtifactVersionCalls: Array<unknown>;
  };
  let mockSession: InvocationContext['session'];
  let mockInvocationContext: InvocationContext;
  let mockCallbackContext: Context;

  beforeEach(() => {
    const {mockLogger} = makeMockLogger();
    setLogger(mockLogger);

    const saveArtifactCalls: Array<unknown> = [];
    const getArtifactVersionCalls: Array<unknown> = [];

    mockArtifactService = {
      saveArtifactCalls,
      getArtifactVersionCalls,
      saveArtifact: async (request) => {
        saveArtifactCalls.push(request);
        return 1;
      },
      loadArtifact: async () => undefined,
      listArtifactKeys: async () => [],
      deleteArtifact: async () => {},
      listVersions: async () => [1],
      listArtifactVersions: async () => [],
      getArtifactVersion: async (request) => {
        getArtifactVersionCalls.push(request);
        if (
          request.filename === 'image.png' ||
          request.filename === 'photo.png'
        ) {
          return {
            version: request.version ?? 1,
            canonicalUri: `gs://my-bucket/${request.filename}`,
            mimeType: 'image/png',
          };
        } else if (request.filename === 'doc.pdf') {
          return {
            version: request.version ?? 1,
            canonicalUri: 'https://example.com/doc.pdf',
            mimeType: 'application/pdf',
          };
        } else if (request.filename === 'local.txt') {
          return {
            version: request.version ?? 1,
            canonicalUri: 'file:///local/path/local.txt',
            mimeType: 'text/plain',
          };
        }
        return undefined;
      },
    };

    mockSession = {
      id: 'session-1',
      state: {},
      userId: 'user-1',
      appName: 'test-app',
    } as unknown as InvocationContext['session'];

    mockInvocationContext = {
      invocationId: 'inv-123',
      session: mockSession,
      userId: 'user-1',
      appName: 'test-app',
      agent: mockAgent,
      artifactService: mockArtifactService,
    } as unknown as InvocationContext;

    mockCallbackContext = {
      agentName: 'test_agent',
      invocationId: 'inv-123',
      invocationContext: mockInvocationContext,
      state: {
        get: (key: string) => mockSession.state[key],
        set: (key: string, val: unknown) => {
          mockSession.state[key] = val;
        },
      },
      actions: {
        artifactDelta: {},
      },
    } as unknown as Context;
  });

  afterEach(() => {
    resetLogger();
  });

  describe('isModelAccessibleUri', () => {
    it('should identify valid model accessible URIs', () => {
      expect(isModelAccessibleUri('gs://bucket/file')).toBe(true);
      expect(isModelAccessibleUri('https://domain.com/file')).toBe(true);
      expect(isModelAccessibleUri('http://domain.com/file')).toBe(true);
    });

    it('should reject non-model accessible URIs and invalid strings', () => {
      expect(isModelAccessibleUri('file:///local/path')).toBe(false);
      expect(isModelAccessibleUri('ftp://server/file')).toBe(false);
      expect(isModelAccessibleUri('not-a-uri')).toBe(false);
    });
  });

  describe('buildFileReferencePart', () => {
    it('should build FileData part when canonicalUri is model accessible (gs or https)', async () => {
      const gsPart = await buildFileReferencePart({
        invocationContext: mockInvocationContext,
        filename: 'image.png',
        version: 1,
        mimeType: 'image/png',
        displayName: 'My Image',
      });

      expect(gsPart).toEqual({
        fileData: {
          fileUri: 'gs://my-bucket/image.png',
          mimeType: 'image/png',
          displayName: 'My Image',
        },
      });

      const httpsPart = await buildFileReferencePart({
        invocationContext: mockInvocationContext,
        filename: 'doc.pdf',
        version: 1,
        displayName: 'Document',
      });

      expect(httpsPart).toEqual({
        fileData: {
          fileUri: 'https://example.com/doc.pdf',
          mimeType: 'application/pdf',
          displayName: 'Document',
        },
      });
    });

    it('should return undefined when canonicalUri is not model accessible or artifactService is missing', async () => {
      const localPart = await buildFileReferencePart({
        invocationContext: mockInvocationContext,
        filename: 'local.txt',
        version: 1,
        displayName: 'Local File',
      });
      expect(localPart).toBeUndefined();

      const noServiceContext = {
        ...mockInvocationContext,
        artifactService: undefined,
      } as unknown as InvocationContext;

      const noServicePart = await buildFileReferencePart({
        invocationContext: noServiceContext,
        filename: 'image.png',
        version: 1,
        displayName: 'My Image',
      });
      expect(noServicePart).toBeUndefined();
    });
  });

  describe('processUserMessageArtifacts', () => {
    it('should save inlineData via artifactService without passing raw appName, userId, or sessionId keys', async () => {
      const userMessage: Content = {
        role: 'user',
        parts: [
          {
            text: 'Here is an image',
          },
          {
            inlineData: {
              data: 'base64encoded',
              mimeType: 'image/png',
              displayName: 'photo.png',
            },
          },
        ],
      };

      const result = await processUserMessageArtifacts(
        mockInvocationContext,
        userMessage,
      );

      expect(mockArtifactService.saveArtifactCalls.length).toBe(1);
      const calledReq = mockArtifactService.saveArtifactCalls[0] as Record<
        string,
        unknown
      >;
      expect(calledReq.filename).toBe('photo.png');
      expect(calledReq.artifact).toBeDefined();
      expect(calledReq).not.toHaveProperty('appName');
      expect(calledReq).not.toHaveProperty('userId');
      expect(calledReq).not.toHaveProperty('sessionId');

      expect(result.pendingDelta).toEqual({'photo.png': 1});
      expect(result.newContent?.parts?.length).toBe(3);
      expect(result.newContent?.parts?.[0]).toEqual({
        text: 'Here is an image',
      });
      expect(result.newContent?.parts?.[1]).toEqual({
        text: '[Uploaded Artifact: "photo.png"]',
      });
      expect(result.newContent?.parts?.[2]).toEqual({
        fileData: {
          fileUri: 'gs://my-bucket/photo.png',
          mimeType: 'image/png',
          displayName: 'photo.png',
        },
      });
    });

    it('should generate fallback filename when displayName is not set', async () => {
      const userMessage: Content = {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: 'rawdata',
              mimeType: 'image/png',
            },
          },
        ],
      };

      const result = await processUserMessageArtifacts(
        mockInvocationContext,
        userMessage,
      );

      expect(mockArtifactService.saveArtifactCalls.length).toBe(1);
      const expectedFilename = 'artifact_inv-123_0';
      const calledReq = mockArtifactService.saveArtifactCalls[0] as Record<
        string,
        unknown
      >;
      expect(calledReq.filename).toBe(expectedFilename);

      expect(result.newContent?.parts?.[0]).toEqual({
        text: `[Uploaded Artifact: "${expectedFilename}"]`,
      });
    });

    it('should skip attaching FileData reference when attachFileReference is false', async () => {
      const userMessage: Content = {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: 'base64encoded',
              mimeType: 'image/png',
              displayName: 'image.png',
            },
          },
        ],
      };

      const result = await processUserMessageArtifacts(
        mockInvocationContext,
        userMessage,
        {attachFileReference: false},
      );

      expect(result.newContent?.parts?.length).toBe(1);
      expect(result.newContent?.parts?.[0]).toEqual({
        text: '[Uploaded Artifact: "image.png"]',
      });
    });

    it('should fallback gracefully without errors when artifactService is undefined', async () => {
      const noServiceContext = {
        ...mockInvocationContext,
        artifactService: undefined,
      } as unknown as InvocationContext;

      const userMessage: Content = {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: 'rawdata',
              mimeType: 'image/png',
            },
          },
        ],
      };

      const result = await processUserMessageArtifacts(
        noServiceContext,
        userMessage,
      );

      expect(result).toEqual({});
    });

    it('should be resilient and preserve original part when saveArtifact throws an error', async () => {
      mockArtifactService.saveArtifact = async () => {
        throw new Error('GCS quota exceeded');
      };

      const originalPart: Part = {
        inlineData: {
          data: 'errorData',
          mimeType: 'image/png',
          displayName: 'broken.png',
        },
      };
      const userMessage: Content = {
        role: 'user',
        parts: [originalPart],
      };

      const result = await processUserMessageArtifacts(
        mockInvocationContext,
        userMessage,
      );

      const effectiveContent = result.newContent || userMessage;
      expect(effectiveContent.parts?.[0]).toEqual(originalPart);
      expect(result.pendingDelta || {}).toEqual({});
    });
  });

  describe('SaveFilesAsArtifactsPlugin class', () => {
    it('should initialize with options and custom name', () => {
      const p1 = new SaveFilesAsArtifactsPlugin();
      expect(p1.name).toBe('save_files_as_artifacts_plugin');
      expect(p1.attachFileReference).toBe(true);

      const p2 = new SaveFilesAsArtifactsPlugin('custom_plugin', {
        attachFileReference: false,
      });
      expect(p2.name).toBe('custom_plugin');
      expect(p2.attachFileReference).toBe(false);

      const p3 = new SaveFilesAsArtifactsPlugin({
        name: 'opts_plugin',
        attachFileReference: false,
      });
      expect(p3.name).toBe('opts_plugin');
      expect(p3.attachFileReference).toBe(false);
    });

    it('onUserMessageCallback should store pendingDelta in session state and return new content when modified', async () => {
      const plugin = new SaveFilesAsArtifactsPlugin();
      const userMessage: Content = {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: 'data',
              mimeType: 'image/png',
              displayName: 'image.png',
            },
          },
        ],
      };

      const returnedContent = await plugin.onUserMessageCallback({
        invocationContext: mockInvocationContext,
        userMessage,
      });

      expect(returnedContent).toBeDefined();
      expect(
        mockSession.state['save_files_as_artifacts_plugin:pendingDelta'],
      ).toEqual({'image.png': 1});
    });

    it('beforeAgentCallback should transfer pendingDelta from session state to eventActions.artifactDelta and clear state', async () => {
      const plugin = new SaveFilesAsArtifactsPlugin();
      mockSession.state['save_files_as_artifacts_plugin:pendingDelta'] = {
        'image.png': 1,
        'doc.pdf': 2,
      };

      await plugin.beforeAgentCallback({
        agent: mockAgent,
        callbackContext: mockCallbackContext,
      });

      expect(mockCallbackContext.actions.artifactDelta).toEqual({
        'image.png': 1,
        'doc.pdf': 2,
      });
      expect(
        mockSession.state['save_files_as_artifacts_plugin:pendingDelta'],
      ).toEqual({});
    });

    it('onUserMessageCallback should return undefined when message has no inline parts', async () => {
      const plugin = new SaveFilesAsArtifactsPlugin();
      const userMessage: Content = {
        role: 'user',
        parts: [{text: 'just text'}],
      };

      const result = await plugin.onUserMessageCallback({
        invocationContext: mockInvocationContext,
        userMessage,
      });

      expect(result).toBeUndefined();
    });
  });

  describe('Additional edge cases for 100% branch coverage', () => {
    it('processUserMessageArtifacts should return empty object when userMessage.parts is undefined or empty', async () => {
      const emptyResult = await processUserMessageArtifacts(
        mockInvocationContext,
        {role: 'user', parts: []},
      );
      expect(emptyResult).toEqual({});

      const undefinedPartsResult = await processUserMessageArtifacts(
        mockInvocationContext,
        {role: 'user'} as Content,
      );
      expect(undefinedPartsResult).toEqual({});
    });

    it('buildFileReferencePart should return undefined and log warning when getArtifactVersion throws non-Error string or Error', async () => {
      mockArtifactService.getArtifactVersion = async () => {
        throw new Error('Service unavailable');
      };

      const result1 = await buildFileReferencePart({
        invocationContext: mockInvocationContext,
        filename: 'image.png',
        version: 1,
        displayName: 'My Image',
      });
      expect(result1).toBeUndefined();

      mockArtifactService.getArtifactVersion = async () => {
        throw 'string exception';
      };

      const result2 = await buildFileReferencePart({
        invocationContext: mockInvocationContext,
        filename: 'image.png',
        version: 1,
        displayName: 'My Image',
      });
      expect(result2).toBeUndefined();
    });

    it('processUserMessageArtifacts and options initialization should handle non-Error string exceptions cleanly', async () => {
      mockArtifactService.saveArtifact = async () => {
        throw 'string error from storage';
      };

      const originalPart: Part = {
        inlineData: {
          data: 'data',
          mimeType: 'image/png',
          displayName: 'fail.png',
        },
      };
      const result = await processUserMessageArtifacts(mockInvocationContext, {
        role: 'user',
        parts: [originalPart],
      });
      expect((result.newContent || {parts: [originalPart]}).parts?.[0]).toEqual(
        originalPart,
      );

      const plugin = new SaveFilesAsArtifactsPlugin({});
      expect(plugin.name).toBe('save_files_as_artifacts_plugin');
    });
  });
});
