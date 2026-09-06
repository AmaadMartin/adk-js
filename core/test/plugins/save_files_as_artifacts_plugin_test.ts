/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `ported from adk-python` block below is ported from
 * tests/unittests/plugins/test_save_files_as_artifacts.py (branch: main).
 * Every `it(...)` string is the reference test name, verbatim.
 */

import {
  ArtifactVersion,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  Logger,
  LogLevel,
  PluginManager,
  SaveFilesAsArtifactsPlugin,
  SessionArtifactService,
  SessionLoadArtifactRequest,
  SessionSaveArtifactRequest,
  setLogger,
  setLogLevel,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {resetLogger} from '../../src/utils/logger.js';

const PENDING_DELTA_KEY = 'save_files_as_artifacts_plugin:pending_delta';
const MAX_INLINE_DATA_SIZE_BYTES = 20 * 1024 * 1024;

/** A base64 string that decodes to exactly `byteLength` bytes. */
function base64OfSize(byteLength: number): string {
  const padding = (3 - (byteLength % 3)) % 3;
  const encodedLength = ((byteLength + padding) / 3) * 4;
  return 'A'.repeat(encodedLength - padding) + '='.repeat(padding);
}

const SMALL_BLOB_DATA = base64OfSize(9);

/**
 * A session-scoped artifact service that records its calls and resolves a
 * `gs://` canonical URI, mirroring the reference fixture. Only the two methods
 * the plugin uses carry behaviour.
 */
class StubArtifactService implements SessionArtifactService {
  readonly saveArtifact = vi.fn(
    async (_request: SessionSaveArtifactRequest): Promise<number> => 0,
  );

  readonly getArtifactVersion = vi.fn(
    async ({
      filename,
      version,
    }: SessionLoadArtifactRequest): Promise<ArtifactVersion | undefined> => ({
      version: version ?? 0,
      canonicalUri: `gs://mock-bucket/${filename}/versions/${version ?? 0}`,
      mimeType: 'application/pdf',
    }),
  );

  async loadArtifact(): Promise<Part | undefined> {
    return undefined;
  }

  async listArtifactKeys(): Promise<string[]> {
    return [];
  }

  async deleteArtifact(): Promise<void> {}

  async listVersions(): Promise<number[]> {
    return [];
  }

  async listArtifactVersions(): Promise<ArtifactVersion[]> {
    return [];
  }
}

interface Harness {
  plugin: SaveFilesAsArtifactsPlugin;
  artifactService: StubArtifactService;
  invocationContext: InvocationContext;
  agent: LlmAgent;
}

function createInvocationContext(
  plugin: SaveFilesAsArtifactsPlugin,
  agent: LlmAgent,
  artifactService?: StubArtifactService,
): InvocationContext {
  return new InvocationContext({
    artifactService,
    invocationId: 'test_invocation_123',
    agent,
    session: createSession({
      id: 'test_session',
      appName: 'test_app',
      userId: 'test_user',
    }),
    pluginManager: new PluginManager([plugin]),
  });
}

function createHarness(plugin = new SaveFilesAsArtifactsPlugin()): Harness {
  const agent = new LlmAgent({name: 'test_agent', model: 'gemini-2.5-flash'});
  const artifactService = new StubArtifactService();
  return {
    plugin,
    artifactService,
    agent,
    invocationContext: createInvocationContext(plugin, agent, artifactService),
  };
}

function inlinePart(
  displayName: string | undefined,
  data: string,
  mimeType = 'application/pdf',
): Part {
  return {inlineData: {displayName, data, mimeType}};
}

describe('SaveFilesAsArtifactsPlugin', () => {
  let harness: Harness;
  const logged: Array<{level: string; message: string}> = [];

  beforeEach(() => {
    logged.length = 0;
    const recordingLogger: Logger = {
      setLogLevel: () => {},
      log: (_level, ...args) =>
        logged.push({level: 'LOG', message: args.join(' ')}),
      debug: (...args) =>
        logged.push({level: 'DEBUG', message: args.join(' ')}),
      info: (...args) => logged.push({level: 'INFO', message: args.join(' ')}),
      warn: (...args) => logged.push({level: 'WARN', message: args.join(' ')}),
      error: (...args) =>
        logged.push({level: 'ERROR', message: args.join(' ')}),
    };
    setLogger(recordingLogger);
    setLogLevel(LogLevel.DEBUG);
    harness = createHarness();
  });

  afterEach(() => {
    resetLogger();
  });

  function messagesAt(level: string): string[] {
    return logged
      .filter((entry) => entry.level === level)
      .map((e) => e.message);
  }

  describe('ported from adk-python', () => {
    it('test_save_files_with_display_name', async () => {
      const {plugin, artifactService, invocationContext} = harness;
      const originalPart = inlinePart('test_document.pdf', SMALL_BLOB_DATA);
      const userMessage: Content = {parts: [originalPart]};

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage,
      });

      // adk-js scopes the artifact service to the session, so `saveArtifact`
      // takes no appName/userId/sessionId. The reference asserts those kwargs.
      expect(artifactService.saveArtifact).toHaveBeenCalledTimes(1);
      expect(artifactService.saveArtifact).toHaveBeenCalledWith({
        filename: 'test_document.pdf',
        artifact: originalPart,
      });

      expect(result?.parts).toHaveLength(2);
      expect(result?.parts?.[0].text).toBe(
        '[Uploaded Artifact: "test_document.pdf"]',
      );
      expect(result?.parts?.[1].fileData).toEqual({
        fileUri: 'gs://mock-bucket/test_document.pdf/versions/0',
        mimeType: 'application/pdf',
        displayName: 'test_document.pdf',
      });
    });

    it('test_attach_file_reference_false', async () => {
      const local = createHarness(
        new SaveFilesAsArtifactsPlugin({attachFileReference: false}),
      );
      const originalPart = inlinePart('test_document.pdf', SMALL_BLOB_DATA);

      const result = await local.plugin.onUserMessageCallback({
        invocationContext: local.invocationContext,
        userMessage: {parts: [originalPart]},
      });

      expect(local.artifactService.saveArtifact).toHaveBeenCalledWith({
        filename: 'test_document.pdf',
        artifact: originalPart,
      });
      expect(local.artifactService.getArtifactVersion).not.toHaveBeenCalled();
      expect(result?.parts).toHaveLength(1);
      expect(result?.parts?.[0].text).toBe(
        '[Uploaded Artifact: "test_document.pdf"]',
      );
    });

    it('test_save_files_without_display_name', async () => {
      const {plugin, artifactService, invocationContext} = harness;
      const originalPart = inlinePart(undefined, SMALL_BLOB_DATA);

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {parts: [originalPart]},
      });

      const expectedFilename = 'artifact_test_invocation_123_0';
      expect(artifactService.saveArtifact).toHaveBeenCalledWith({
        filename: expectedFilename,
        artifact: originalPart,
      });
      expect(result?.parts).toHaveLength(2);
      expect(result?.parts?.[0].text).toBe(
        `[Uploaded Artifact: "${expectedFilename}"]`,
      );
      expect(result?.parts?.[1].fileData?.fileUri).toBe(
        `gs://mock-bucket/${expectedFilename}/versions/0`,
      );
      expect(result?.parts?.[1].fileData?.displayName).toBe(expectedFilename);
      expect(messagesAt('INFO')).toContain(
        `No displayName found, using generated filename: ${expectedFilename}`,
      );
    });

    it('test_multiple_files_in_message', async () => {
      const {plugin, artifactService, invocationContext} = harness;

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          parts: [
            inlinePart('file1.txt', SMALL_BLOB_DATA, 'text/plain'),
            {text: 'Some text between files'},
            inlinePart('file2.jpg', SMALL_BLOB_DATA, 'image/jpeg'),
          ],
        },
      });

      expect(artifactService.saveArtifact).toHaveBeenCalledTimes(2);
      expect(artifactService.saveArtifact.mock.calls[0][0].filename).toBe(
        'file1.txt',
      );
      expect(artifactService.saveArtifact.mock.calls[1][0].filename).toBe(
        'file2.jpg',
      );

      expect(result?.parts).toHaveLength(5);
      expect(result?.parts?.[0].text).toBe('[Uploaded Artifact: "file1.txt"]');
      expect(result?.parts?.[1].fileData?.fileUri).toBe(
        'gs://mock-bucket/file1.txt/versions/0',
      );
      expect(result?.parts?.[1].fileData?.displayName).toBe('file1.txt');
      expect(result?.parts?.[2].text).toBe('Some text between files');
      expect(result?.parts?.[3].text).toBe('[Uploaded Artifact: "file2.jpg"]');
      expect(result?.parts?.[4].fileData?.fileUri).toBe(
        'gs://mock-bucket/file2.jpg/versions/0',
      );
      expect(result?.parts?.[4].fileData?.displayName).toBe('file2.jpg');
    });

    it('test_no_artifact_service', async () => {
      const {plugin, agent} = harness;
      const invocationContext = createInvocationContext(plugin, agent);
      const userMessage: Content = {
        parts: [inlinePart('test.pdf', SMALL_BLOB_DATA)],
      };

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage,
      });

      expect(result).toBe(userMessage);
      expect(result?.parts?.[0].inlineData).toEqual(
        userMessage.parts?.[0].inlineData,
      );
      expect(messagesAt('WARN')).toContain(
        'Artifact service is not set. SaveFilesAsArtifactsPlugin will not be' +
          ' enabled.',
      );
    });

    it('test_no_parts_in_message', async () => {
      const {plugin, artifactService, invocationContext} = harness;

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {parts: []},
      });

      expect(result).toBeUndefined();
      expect(artifactService.saveArtifact).not.toHaveBeenCalled();
    });

    it('test_parts_without_inline_data', async () => {
      const {plugin, artifactService, invocationContext} = harness;

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          parts: [{text: 'Hello world'}, {text: 'No files here'}],
        },
      });

      expect(result).toBeUndefined();
      expect(artifactService.saveArtifact).not.toHaveBeenCalled();
    });

    it('test_save_artifact_failure', async () => {
      const {plugin, artifactService, invocationContext} = harness;
      artifactService.saveArtifact.mockRejectedValue(
        new Error('Storage error'),
      );

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {parts: [inlinePart('test.pdf', SMALL_BLOB_DATA)]},
      });

      expect(result).toBeUndefined();
      expect(messagesAt('ERROR')).toContain(
        'Failed to save artifact for part 0: Storage error',
      );
    });

    it('test_mixed_success_and_failure', async () => {
      const {plugin, artifactService, invocationContext} = harness;
      artifactService.saveArtifact
        .mockResolvedValueOnce(0)
        .mockRejectedValueOnce(new Error('Storage error on second file'));

      const originalPart2 = inlinePart('failure.pdf', SMALL_BLOB_DATA);

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          parts: [inlinePart('success.pdf', SMALL_BLOB_DATA), originalPart2],
        },
      });

      expect(result?.parts).toHaveLength(3);
      expect(result?.parts?.[0].text).toBe(
        '[Uploaded Artifact: "success.pdf"]',
      );
      expect(result?.parts?.[1].fileData).toBeDefined();
      expect(result?.parts?.[2]).toBe(originalPart2);
    });

    it('test_placeholder_text_format', async () => {
      const {plugin, invocationContext} = harness;

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          parts: [
            inlinePart(
              'test file with spaces.docx',
              SMALL_BLOB_DATA,
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            ),
          ],
        },
      });

      expect(result?.parts?.[0].text).toBe(
        '[Uploaded Artifact: "test file with spaces.docx"]',
      );
      expect(result?.parts?.[1].fileData).toBeDefined();
    });

    it('test_plugin_name_default', () => {
      expect(new SaveFilesAsArtifactsPlugin().name).toBe(
        'save_files_as_artifacts_plugin',
      );
    });

    it('test_file_size_exceeds_limit', async () => {
      const {plugin, artifactService, invocationContext} = harness;

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          parts: [inlinePart('large_file.pdf', base64OfSize(21 * 1024 * 1024))],
        },
      });

      expect(artifactService.saveArtifact).not.toHaveBeenCalled();
      expect(result?.parts).toHaveLength(1);
      expect(result?.parts?.[0].text).toBe(
        '[Upload Error: File large_file.pdf (21.00 MB) exceeds the maximum' +
          ' supported size of 20MB. Please upload a smaller file.]',
      );
    });

    it('test_file_size_at_limit', async () => {
      const {plugin, artifactService, invocationContext} = harness;

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          parts: [
            inlinePart(
              'max_size_file.pdf',
              base64OfSize(MAX_INLINE_DATA_SIZE_BYTES),
            ),
          ],
        },
      });

      expect(artifactService.saveArtifact).toHaveBeenCalledTimes(1);
      expect(result?.parts).toHaveLength(2);
      expect(result?.parts?.[0].text).toBe(
        '[Uploaded Artifact: "max_size_file.pdf"]',
      );
      expect(result?.parts?.[1].fileData).toBeDefined();
    });

    it('test_file_size_just_over_limit', async () => {
      const {plugin, artifactService, invocationContext} = harness;

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          parts: [
            inlinePart(
              'slightly_too_large.pdf',
              base64OfSize(MAX_INLINE_DATA_SIZE_BYTES + 1),
            ),
          ],
        },
      });

      expect(artifactService.saveArtifact).not.toHaveBeenCalled();
      expect(result?.parts).toHaveLength(1);
      expect(result?.parts?.[0].text).toContain('[Upload Error:');
      expect(result?.parts?.[0].text).toContain('slightly_too_large.pdf');
      expect(result?.parts?.[0].text).toContain(
        'exceeds the maximum supported size of 20MB',
      );
    });

    it('test_mixed_file_sizes', async () => {
      const {plugin, artifactService, invocationContext} = harness;

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          parts: [
            inlinePart('small.pdf', base64OfSize(5 * 1024 * 1024)),
            inlinePart('large.pdf', base64OfSize(25 * 1024 * 1024)),
          ],
        },
      });

      expect(artifactService.saveArtifact).toHaveBeenCalledTimes(1);
      expect(result?.parts).toHaveLength(3);
      expect(result?.parts?.[0].text).toBe('[Uploaded Artifact: "small.pdf"]');
      expect(result?.parts?.[1].fileData).toBeDefined();
      expect(result?.parts?.[2].text).toBe(
        '[Upload Error: File large.pdf (25.00 MB) exceeds the maximum' +
          ' supported size of 20MB. Please upload a smaller file.]',
      );
    });

    it('test_artifact_delta_reporting', async () => {
      const {plugin, agent, invocationContext} = harness;
      const state = invocationContext.session.state;

      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {parts: [inlinePart('blob.pdf', SMALL_BLOB_DATA)]},
      });
      expect(state[PENDING_DELTA_KEY]).toEqual({'blob.pdf': 0});

      const callbackContext = new Context({invocationContext});
      await plugin.beforeAgentCallback({agent, callbackContext});
      expect(callbackContext.actions.artifactDelta).toEqual({'blob.pdf': 0});
      expect(state[PENDING_DELTA_KEY]).toEqual({});

      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {parts: [inlinePart('blob_2.pdf', SMALL_BLOB_DATA)]},
      });
      expect(state[PENDING_DELTA_KEY]).toEqual({'blob_2.pdf': 0});

      const callbackContext2 = new Context({invocationContext});
      await plugin.beforeAgentCallback({
        agent,
        callbackContext: callbackContext2,
      });
      expect(callbackContext2.actions.artifactDelta).toEqual({'blob_2.pdf': 0});
      expect(state[PENDING_DELTA_KEY]).toEqual({});
    });
  });

  describe('file reference resolution', () => {
    it('keeps the placeholder and the delta when getArtifactVersion rejects', async () => {
      const {plugin, artifactService, invocationContext} = harness;
      artifactService.getArtifactVersion.mockRejectedValue(
        new Error('metadata unavailable'),
      );

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {parts: [inlinePart('doc.pdf', SMALL_BLOB_DATA)]},
      });

      expect(result?.parts).toHaveLength(1);
      expect(result?.parts?.[0].text).toBe('[Uploaded Artifact: "doc.pdf"]');
      expect(artifactService.saveArtifact).toHaveBeenCalledTimes(1);
      expect(invocationContext.session.state[PENDING_DELTA_KEY]).toEqual({
        'doc.pdf': 0,
      });
      expect(messagesAt('WARN')).toContain(
        'Failed to resolve artifact version for doc.pdf: metadata unavailable',
      );
    });

    it('omits the file reference when the version record is missing', async () => {
      const {plugin, artifactService, invocationContext} = harness;
      artifactService.getArtifactVersion.mockResolvedValue(undefined);

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {parts: [inlinePart('doc.pdf', SMALL_BLOB_DATA)]},
      });

      expect(result?.parts).toHaveLength(1);
      expect(result?.parts?.[0].text).toBe('[Uploaded Artifact: "doc.pdf"]');
    });

    it('omits the file reference when the version record has no canonicalUri', async () => {
      const {plugin, artifactService, invocationContext} = harness;
      artifactService.getArtifactVersion.mockResolvedValue({version: 0});

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {parts: [inlinePart('doc.pdf', SMALL_BLOB_DATA)]},
      });

      expect(result?.parts).toHaveLength(1);
    });

    it.each([
      ['gs://bucket/doc.pdf', true],
      ['https://example.com/doc.pdf', true],
      ['http://example.com/doc.pdf', true],
      ['HTTPS://example.com/doc.pdf', true],
      ['memory://doc.pdf', false],
      ['file:///tmp/doc.pdf', false],
      ['/tmp/doc.pdf', false],
      ['not a uri at all', false],
    ])('attaches a file reference for %s: %s', async (uri, accessible) => {
      const {plugin, artifactService, invocationContext} = harness;
      artifactService.getArtifactVersion.mockResolvedValue({
        version: 0,
        canonicalUri: uri,
        mimeType: 'application/pdf',
      });

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {parts: [inlinePart('doc.pdf', SMALL_BLOB_DATA)]},
      });

      expect(result?.parts).toHaveLength(accessible ? 2 : 1);
      if (accessible) {
        expect(result?.parts?.[1].fileData?.fileUri).toBe(uri);
      }
    });

    it("prefers the blob's mime type over the version record's", async () => {
      const {plugin, artifactService, invocationContext} = harness;
      artifactService.getArtifactVersion.mockResolvedValue({
        version: 0,
        canonicalUri: 'gs://bucket/doc.bin',
        mimeType: 'application/octet-stream',
      });

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          parts: [inlinePart('doc.bin', SMALL_BLOB_DATA, 'image/png')],
        },
      });

      expect(result?.parts?.[1].fileData?.mimeType).toBe('image/png');
    });

    it("falls back to the version record's mime type when the blob has none", async () => {
      const {plugin, artifactService, invocationContext} = harness;
      artifactService.getArtifactVersion.mockResolvedValue({
        version: 0,
        canonicalUri: 'gs://bucket/doc.bin',
        mimeType: 'application/octet-stream',
      });

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          parts: [
            {inlineData: {displayName: 'doc.bin', data: SMALL_BLOB_DATA}},
          ],
        },
      });

      expect(result?.parts?.[1].fileData?.mimeType).toBe(
        'application/octet-stream',
      );
    });
  });

  describe('message rewriting', () => {
    it('preserves the role on the returned message', async () => {
      const {plugin, invocationContext} = harness;

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          role: 'user',
          parts: [inlinePart('doc.pdf', SMALL_BLOB_DATA)],
        },
      });

      expect(result?.role).toBe('user');
    });

    it('treats a blob with no data as empty and saves it', async () => {
      const {plugin, artifactService, invocationContext} = harness;

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          role: 'user',
          parts: [{inlineData: {displayName: 'empty.pdf'}}],
        },
      });

      expect(artifactService.saveArtifact).toHaveBeenCalledTimes(1);
      expect(result?.parts?.[0].text).toBe('[Uploaded Artifact: "empty.pdf"]');
    });

    it('returns undefined when parts is absent', async () => {
      const {plugin, artifactService, invocationContext} = harness;

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {role: 'user'},
      });

      expect(result).toBeUndefined();
      expect(artifactService.saveArtifact).not.toHaveBeenCalled();
    });

    it('leaves the input message and its parts array untouched', async () => {
      const {plugin, invocationContext} = harness;
      const originalPart = inlinePart('doc.pdf', SMALL_BLOB_DATA);
      const userMessage: Content = {role: 'user', parts: [originalPart]};

      const result = await plugin.onUserMessageCallback({
        invocationContext,
        userMessage,
      });

      expect(result).not.toBe(userMessage);
      expect(userMessage.parts).toHaveLength(1);
      expect(userMessage.parts?.[0]).toBe(originalPart);
      expect(originalPart.inlineData?.data).toBe(SMALL_BLOB_DATA);
    });

    it('copies the part so a later mutation cannot reach the saved artifact', async () => {
      const {plugin, artifactService, invocationContext} = harness;
      const originalPart = inlinePart('doc.pdf', SMALL_BLOB_DATA);

      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {role: 'user', parts: [originalPart]},
      });

      const saved = artifactService.saveArtifact.mock.calls[0][0].artifact;
      originalPart.text = 'mutated after the save';

      expect(saved).not.toBe(originalPart);
      expect(saved.text).toBeUndefined();
    });
  });

  describe('pending delta stash', () => {
    it('keys the stash by the plugin name', async () => {
      const local = createHarness(
        new SaveFilesAsArtifactsPlugin({name: 'custom_saver'}),
      );

      expect(local.plugin.name).toBe('custom_saver');

      await local.plugin.onUserMessageCallback({
        invocationContext: local.invocationContext,
        userMessage: {parts: [inlinePart('doc.pdf', SMALL_BLOB_DATA)]},
      });

      expect(
        local.invocationContext.session.state['custom_saver:pending_delta'],
      ).toEqual({'doc.pdf': 0});
      expect(
        local.invocationContext.session.state[PENDING_DELTA_KEY],
      ).toBeUndefined();
    });

    it('merges a second save into an undrained stash', async () => {
      const {plugin, invocationContext} = harness;

      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {parts: [inlinePart('first.pdf', SMALL_BLOB_DATA)]},
      });
      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {parts: [inlinePart('second.pdf', SMALL_BLOB_DATA)]},
      });

      expect(invocationContext.session.state[PENDING_DELTA_KEY]).toEqual({
        'first.pdf': 0,
        'second.pdf': 0,
      });
    });

    it('replaces a malformed stash rather than merging into it', async () => {
      const {plugin, invocationContext} = harness;
      invocationContext.session.state[PENDING_DELTA_KEY] = 'not a delta';

      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {parts: [inlinePart('doc.pdf', SMALL_BLOB_DATA)]},
      });

      expect(invocationContext.session.state[PENDING_DELTA_KEY]).toEqual({
        'doc.pdf': 0,
      });
    });

    it('does not record a delta for an oversize file', async () => {
      const {plugin, invocationContext} = harness;

      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {
          parts: [inlinePart('huge.pdf', base64OfSize(21 * 1024 * 1024))],
        },
      });

      expect(invocationContext.session.state[PENDING_DELTA_KEY]).toEqual({});
    });
  });

  describe('beforeAgentCallback', () => {
    it('leaves artifactDelta untouched when nothing is stashed', async () => {
      const {plugin, agent, invocationContext} = harness;
      const callbackContext = new Context({invocationContext});

      await plugin.beforeAgentCallback({agent, callbackContext});

      expect(callbackContext.actions.artifactDelta).toEqual({});
      expect(callbackContext.state.hasDelta()).toBe(false);
    });

    it('is a no-op on the second call because the first clears the stash', async () => {
      const {plugin, agent, invocationContext} = harness;
      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {parts: [inlinePart('doc.pdf', SMALL_BLOB_DATA)]},
      });

      const first = new Context({invocationContext});
      await plugin.beforeAgentCallback({agent, callbackContext: first});
      expect(first.actions.artifactDelta).toEqual({'doc.pdf': 0});

      const second = new Context({invocationContext});
      await plugin.beforeAgentCallback({agent, callbackContext: second});
      expect(second.actions.artifactDelta).toEqual({});
      expect(second.state.hasDelta()).toBe(false);
    });

    it('clears a malformed stash without merging it', async () => {
      const {plugin, agent, invocationContext} = harness;
      invocationContext.session.state[PENDING_DELTA_KEY] = {
        'doc.pdf': 'version one',
      };
      const callbackContext = new Context({invocationContext});

      await plugin.beforeAgentCallback({agent, callbackContext});

      expect(callbackContext.actions.artifactDelta).toEqual({});
      expect(invocationContext.session.state[PENDING_DELTA_KEY]).toEqual({});
      expect(messagesAt('WARN')).toContain(
        'Discarding a malformed pending artifact delta under state key' +
          ` "${PENDING_DELTA_KEY}".`,
      );
    });

    it('clears a stash that is not an object', async () => {
      const {plugin, agent, invocationContext} = harness;
      invocationContext.session.state[PENDING_DELTA_KEY] = 'not a delta';
      const callbackContext = new Context({invocationContext});

      await plugin.beforeAgentCallback({agent, callbackContext});

      expect(callbackContext.actions.artifactDelta).toEqual({});
      expect(invocationContext.session.state[PENDING_DELTA_KEY]).toEqual({});
    });

    it('leaves an already-empty stash alone rather than rewriting it', async () => {
      const {plugin, agent, invocationContext} = harness;
      invocationContext.session.state[PENDING_DELTA_KEY] = {};
      const callbackContext = new Context({invocationContext});

      await plugin.beforeAgentCallback({agent, callbackContext});

      expect(callbackContext.actions.artifactDelta).toEqual({});
      expect(callbackContext.state.hasDelta()).toBe(false);
    });

    it('merges into an artifactDelta that already has entries', async () => {
      const {plugin, agent, invocationContext} = harness;
      await plugin.onUserMessageCallback({
        invocationContext,
        userMessage: {parts: [inlinePart('doc.pdf', SMALL_BLOB_DATA)]},
      });

      const callbackContext = new Context({invocationContext});
      callbackContext.actions.artifactDelta['earlier.png'] = 3;

      await plugin.beforeAgentCallback({agent, callbackContext});

      expect(callbackContext.actions.artifactDelta).toEqual({
        'earlier.png': 3,
        'doc.pdf': 0,
      });
    });
  });
});
