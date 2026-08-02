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

  it('saves every file and reports its filename and version', async () => {
    const artifactService = createArtifactService();
    const saveSpy = vi.spyOn(artifactService, 'saveArtifact');
    const context = createContext(artifactService);

    const result = await saveFilesAsArtifacts(context, [
      textFile('first.txt', 'one'),
      textFile('second.txt', 'two'),
    ]);

    expect(result).toEqual({
      savedArtifacts: [
        {filename: 'first.txt', version: 0},
        {filename: 'second.txt', version: 0},
      ],
      artifactSaveErrors: [],
    });
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

  it('records the saved version in the event actions artifact delta', async () => {
    const artifactService = createArtifactService();
    const context = createContext(artifactService);

    const result = await saveFilesAsArtifacts(context, [
      textFile('delta.txt', 'content'),
    ]);

    expect(context.eventActions.artifactDelta['delta.txt']).toBe(
      result?.savedArtifacts[0].version,
    );
  });

  it('returns undefined and warns when no artifact service is configured', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const context = createContext();

    const result = await saveFilesAsArtifacts(context, [
      textFile('orphan.txt', 'content'),
    ]);

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('reports a failing save per file and still saves the rest', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const artifactService = createArtifactService();
    vi.spyOn(artifactService, 'saveArtifact').mockRejectedValueOnce(
      new Error('artifact backend unavailable'),
    );
    const context = createContext(artifactService);

    const result = await saveFilesAsArtifacts(context, [
      textFile('doomed.txt', 'one'),
      textFile('survivor.txt', 'two'),
    ]);

    expect(result).toEqual({
      savedArtifacts: [{filename: 'survivor.txt', version: 0}],
      artifactSaveErrors: [
        {filename: 'doomed.txt', error: 'artifact backend unavailable'},
      ],
    });
    expect(errorSpy).toHaveBeenCalledOnce();
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

    expect(result?.savedArtifacts).toEqual([
      {filename: 'allowed.txt', version: 0},
    ]);
    expect(result?.artifactSaveErrors).toEqual([
      {
        filename: 'user:escalated.txt',
        error:
          "Artifact names starting with 'user:' are not accepted from " +
          'produced files.',
      },
    ]);
    expect(saveSpy).toHaveBeenCalledOnce();
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({filename: 'allowed.txt'}),
    );
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
