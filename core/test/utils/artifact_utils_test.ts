/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
// `saveFilesAsArtifacts` is internal, so it and the types it consumes are all
// imported from source: mixing in `@google/adk` would give `Context` two
// distinct declarations and break type identity at the call site.
import {Context} from '../../src/agents/context.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {InMemoryArtifactService} from '../../src/artifacts/in_memory_artifact_service.js';
import {ScopedArtifactService} from '../../src/artifacts/scoped_artifact_service.js';
import {
  File,
  FileContentEncoding,
} from '../../src/code_executors/code_execution_utils.js';
import {saveFilesAsArtifacts} from '../../src/utils/artifact_utils.js';
import {logger} from '../../src/utils/logger.js';

const APP_NAME = 'test-app';
const USER_ID = 'test-user';
const SESSION_ID = 'test-session';

describe('saveFilesAsArtifacts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createArtifactService(): ScopedArtifactService {
    return new ScopedArtifactService(
      new InMemoryArtifactService(),
      APP_NAME,
      USER_ID,
      SESSION_ID,
    );
  }

  function createContext(artifactService?: ScopedArtifactService): Context {
    return new Context({
      invocationContext: {
        session: {state: {}},
        agent: {name: 'test-agent'},
        artifactService,
      } as unknown as InvocationContext,
    });
  }

  function textFile(name: string, content: string): File {
    return {
      name,
      content,
      contentEncoding: FileContentEncoding.UTF8,
      mimeType: 'text/plain',
    };
  }

  it('saves every file and maps its filename to its version', async () => {
    const artifactService = createArtifactService();
    const saveSpy = vi.spyOn(artifactService, 'saveArtifact');
    const context = createContext(artifactService);

    const result = await saveFilesAsArtifacts(context, [
      textFile('first.txt', 'one'),
      textFile('second.txt', 'two'),
    ]);

    expect(result).toEqual({'first.txt': 0, 'second.txt': 0});
    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(saveSpy).toHaveBeenNthCalledWith(1, {
      filename: 'first.txt',
      artifact: {
        inlineData: {
          data: Buffer.from('one', 'utf-8').toString('base64'),
          mimeType: 'text/plain',
        },
      },
    });
  });

  it('maps each file to the version its own save resolved to', async () => {
    const artifactService = createArtifactService();
    vi.spyOn(artifactService, 'saveArtifact')
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(7);
    const context = createContext(artifactService);

    const result = await saveFilesAsArtifacts(context, [
      textFile('first.txt', 'one'),
      textFile('second.txt', 'two'),
    ]);

    expect(result).toEqual({'first.txt': 3, 'second.txt': 7});
  });

  it('base64-encodes utf-8 content exactly once', async () => {
    const artifactService = createArtifactService();
    const context = createContext(artifactService);

    await saveFilesAsArtifacts(context, [
      textFile('greeting.txt', 'hello from script file'),
    ]);

    const artifact = await artifactService.loadArtifact({
      filename: 'greeting.txt',
    });
    const data = artifact?.inlineData?.data;
    if (data === undefined) {
      expect.fail('expected the saved artifact to carry inline data');
    }
    expect(Buffer.from(data, 'base64').toString('utf-8')).toBe(
      'hello from script file',
    );
  });

  it('passes base64 content through without re-encoding it', async () => {
    const artifactService = createArtifactService();
    const context = createContext(artifactService);
    const encoded = Buffer.from('binary bytes', 'utf-8').toString('base64');

    await saveFilesAsArtifacts(context, [
      {
        name: 'image.png',
        content: encoded,
        contentEncoding: FileContentEncoding.BASE64,
        mimeType: 'image/png',
      },
    ]);

    const artifact = await artifactService.loadArtifact({
      filename: 'image.png',
    });
    expect(artifact?.inlineData?.data).toBe(encoded);
    expect(artifact?.inlineData?.mimeType).toBe('image/png');
  });

  it('treats an absent content encoding as base64', async () => {
    const artifactService = createArtifactService();
    const context = createContext(artifactService);
    const encoded = Buffer.from('sandbox bytes', 'utf-8').toString('base64');

    await saveFilesAsArtifacts(context, [
      {name: 'chart.png', content: encoded, mimeType: 'image/png'},
    ]);

    const artifact = await artifactService.loadArtifact({
      filename: 'chart.png',
    });
    expect(artifact?.inlineData?.data).toBe(encoded);
  });

  it('records the saved version in the event actions artifact delta', async () => {
    const artifactService = createArtifactService();
    const context = createContext(artifactService);

    const result = await saveFilesAsArtifacts(context, [
      textFile('delta.txt', 'content'),
    ]);

    expect(context.eventActions.artifactDelta).toEqual({
      'delta.txt': result['delta.txt'],
    });
  });

  it('skips silently when no artifact service is configured', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const context = createContext();

    const result = await saveFilesAsArtifacts(context, [
      textFile('orphan.txt', 'content'),
      textFile('second.txt', 'content'),
    ]);

    expect(result).toEqual({});
    expect(context.eventActions.artifactDelta).toEqual({});
    // Skipped, not attempted-and-failed: an unconfigured artifact service is a
    // supported setup and must not produce a warning per output file.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledOnce();
  });

  it('returns an empty map without saving when there are no files', async () => {
    const artifactService = createArtifactService();
    const saveSpy = vi.spyOn(artifactService, 'saveArtifact');
    const context = createContext(artifactService);

    expect(await saveFilesAsArtifacts(context, [])).toEqual({});
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('omits a failing file and still saves the rest', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const artifactService = createArtifactService();
    vi.spyOn(artifactService, 'saveArtifact').mockRejectedValueOnce(
      new Error('artifact backend unavailable'),
    );
    const context = createContext(artifactService);

    const result = await saveFilesAsArtifacts(context, [
      textFile('doomed.txt', 'one'),
      textFile('survivor.txt', 'two'),
    ]);

    expect(result).toEqual({'survivor.txt': 0});
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('artifact backend unavailable');
  });

  it('refuses a filename in the user namespace without calling saveArtifact', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const artifactService = createArtifactService();
    const saveSpy = vi.spyOn(artifactService, 'saveArtifact');
    const context = createContext(artifactService);

    const result = await saveFilesAsArtifacts(context, [
      textFile('user:escalated.txt', 'one'),
      textFile('allowed.txt', 'two'),
    ]);

    expect(result).toEqual({'allowed.txt': 0});
    expect(saveSpy).toHaveBeenCalledOnce();
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({filename: 'allowed.txt'}),
    );
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('user:escalated.txt');
  });
});
