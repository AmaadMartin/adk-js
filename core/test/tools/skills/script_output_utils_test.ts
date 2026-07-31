/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {Context} from '../../../src/agents/context.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {InMemoryArtifactService} from '../../../src/artifacts/in_memory_artifact_service.js';
import {ScopedArtifactService} from '../../../src/artifacts/scoped_artifact_service.js';
import {SessionArtifactService} from '../../../src/artifacts/session_artifact_service.js';
import {
  File,
  FileContentEncoding,
} from '../../../src/code_executors/code_execution_utils.js';
import {saveScriptOutputs} from '../../../src/tools/skill/script_output_utils.js';
import {logger} from '../../../src/utils/logger.js';

function createSessionArtifactService(): SessionArtifactService {
  return new ScopedArtifactService(
    new InMemoryArtifactService(),
    'test-app',
    'test-user',
    'test-session',
  );
}

function createContext(artifactService?: SessionArtifactService): Context {
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

/** Reads back the base64 payload an artifact was saved with. */
async function loadInlineData(
  artifactService: SessionArtifactService,
  filename: string,
): Promise<string> {
  const artifact = await artifactService.loadArtifact({filename});
  const data = artifact?.inlineData?.data;
  if (data === undefined) {
    expect.fail(`Artifact '${filename}' has no inline data.`);
  }
  return data;
}

describe('saveScriptOutputs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an empty file list and saves nothing when the script produced no files', async () => {
    const artifactService = createSessionArtifactService();
    const toolContext = createContext(artifactService);

    const response = await saveScriptOutputs(toolContext, {
      stdout: 'done',
      stderr: '',
      outputFiles: [],
    });

    expect(response).toEqual({stdout: 'done', stderr: '', outputFiles: []});
    expect(await artifactService.listArtifactKeys()).toEqual([]);
    expect(toolContext.actions.artifactDelta).toEqual({});
  });

  it('saves each output file to the artifact service and returns only names and mime types', async () => {
    const artifactService = createSessionArtifactService();
    const toolContext = createContext(artifactService);

    const response = await saveScriptOutputs(toolContext, {
      stdout: 'script stdout',
      stderr: 'script stderr',
      outputFiles: [
        textFile('report.csv', 'a,b'),
        {
          name: 'chart.png',
          content: 'AAEC',
          contentEncoding: FileContentEncoding.BASE64,
          mimeType: 'image/png',
        },
      ],
    });

    expect(response).toEqual({
      stdout: 'script stdout',
      stderr: 'script stderr',
      outputFiles: [
        {name: 'report.csv', mimeType: 'text/plain'},
        {name: 'chart.png', mimeType: 'image/png'},
      ],
    });
    // The model must never receive the file bytes.
    expect(Object.keys(response.outputFiles[0])).toEqual(['name', 'mimeType']);
    expect((await artifactService.listArtifactKeys()).sort()).toEqual([
      'chart.png',
      'report.csv',
    ]);
  });

  it('base64-encodes utf-8 file content before saving', async () => {
    const artifactService = createSessionArtifactService();
    const toolContext = createContext(artifactService);

    await saveScriptOutputs(toolContext, {
      stdout: '',
      stderr: '',
      outputFiles: [textFile('out.txt', 'hello')],
    });

    expect(await loadInlineData(artifactService, 'out.txt')).toBe(
      Buffer.from('hello', 'utf-8').toString('base64'),
    );
  });

  it('passes base64 file content through unchanged', async () => {
    const artifactService = createSessionArtifactService();
    const toolContext = createContext(artifactService);

    await saveScriptOutputs(toolContext, {
      stdout: '',
      stderr: '',
      outputFiles: [
        {
          name: 'out.bin',
          content: 'aGVsbG8=',
          contentEncoding: FileContentEncoding.BASE64,
          mimeType: 'application/octet-stream',
        },
      ],
    });

    expect(await loadInlineData(artifactService, 'out.bin')).toBe('aGVsbG8=');
  });

  it('treats content with no declared encoding as base64', async () => {
    const artifactService = createSessionArtifactService();
    const toolContext = createContext(artifactService);

    await saveScriptOutputs(toolContext, {
      stdout: '',
      stderr: '',
      outputFiles: [
        {name: 'out.png', content: 'aGVsbG8=', mimeType: 'image/png'},
      ],
    });

    expect(await loadInlineData(artifactService, 'out.png')).toBe('aGVsbG8=');
  });

  it('records an artifact delta for each saved file', async () => {
    const artifactService = createSessionArtifactService();
    const toolContext = createContext(artifactService);

    await saveScriptOutputs(toolContext, {
      stdout: '',
      stderr: '',
      outputFiles: [textFile('a.txt', 'a'), textFile('b.txt', 'b')],
    });

    expect(toolContext.actions.artifactDelta).toEqual({
      'a.txt': 0,
      'b.txt': 0,
    });
  });

  it('saves a repeated filename as a new artifact version', async () => {
    const artifactService = createSessionArtifactService();

    await saveScriptOutputs(createContext(artifactService), {
      stdout: '',
      stderr: '',
      outputFiles: [textFile('report.csv', 'first')],
    });
    const secondContext = createContext(artifactService);
    const response = await saveScriptOutputs(secondContext, {
      stdout: '',
      stderr: '',
      outputFiles: [textFile('report.csv', 'second')],
    });

    expect(response.outputFiles).toEqual([
      {name: 'report.csv', mimeType: 'text/plain'},
    ]);
    expect(secondContext.actions.artifactDelta).toEqual({'report.csv': 1});
    expect(await artifactService.listVersions('report.csv')).toEqual([0, 1]);
  });

  it('reports produced files with a warning when no artifact service is configured', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const toolContext = createContext();

    const response = await saveScriptOutputs(toolContext, {
      stdout: 'script stdout',
      stderr: 'script stderr',
      outputFiles: [textFile('out.txt', 'hello')],
    });

    expect(response).toEqual({
      stdout: 'script stdout',
      stderr: 'script stderr',
      outputFiles: [{name: 'out.txt', mimeType: 'text/plain'}],
      warning:
        'No artifact service is configured; 1 output file(s) produced by the ' +
        'script were discarded.',
    });
    expect(warnSpy).toHaveBeenCalledWith(response.warning);
  });

  it('returns the saved subset with a warning when an artifact save fails', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const artifactService = createSessionArtifactService();
    const reason = new Error('artifact backend unavailable');
    const save = artifactService.saveArtifact.bind(artifactService);
    vi.spyOn(artifactService, 'saveArtifact').mockImplementation((request) =>
      request.filename === 'b.txt' ? Promise.reject(reason) : save(request),
    );
    const toolContext = createContext(artifactService);

    const response = await saveScriptOutputs(toolContext, {
      stdout: 'script stdout',
      stderr: 'script stderr',
      outputFiles: [
        textFile('a.txt', 'a'),
        textFile('b.txt', 'b'),
        textFile('c.txt', 'c'),
      ],
    });

    expect(response).toEqual({
      stdout: 'script stdout',
      stderr: 'script stderr',
      outputFiles: [
        {name: 'a.txt', mimeType: 'text/plain'},
        {name: 'c.txt', mimeType: 'text/plain'},
      ],
      warning:
        'Failed to save 1 of 3 output file(s) to the artifact service: b.txt.',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to save output file 'b.txt' to the artifact service.",
      reason,
    );
    expect(toolContext.actions.artifactDelta).toEqual({'a.txt': 0, 'c.txt': 0});
  });
});
