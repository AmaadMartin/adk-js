/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DatabaseSessionService,
  FileArtifactService,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  VertexAiMemoryBankService,
} from '@google/adk';
import {Command, Option} from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  closeServices,
  MEMORY_SERVICE_URI_OPTION,
  NO_USE_LOCAL_STORAGE_OPTION,
  resolveEffectiveLocalStorage,
  resolveServices,
  resolveUseLocalStorage,
  USE_LOCAL_STORAGE_OPTION,
} from '../../src/cli/service_options.js';

const SESSION_SERVICE_URI_OPTION = new Option('--session_service_uri <string>');
const ARTIFACT_SERVICE_URI_OPTION = new Option(
  '--artifact_service_uri <string>',
);

const STORAGE_ENV_VARS = [
  'ADK_DISABLE_LOCAL_STORAGE',
  'ADK_FORCE_LOCAL_STORAGE',
  'K_SERVICE',
  'KUBERNETES_SERVICE_HOST',
  'DATABASE_URL',
];

describe('service_options', () => {
  let baseDir: string;
  const originalEnv = {...process.env};

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-services-'));
    for (const name of STORAGE_ENV_VARS) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    fs.rmSync(baseDir, {recursive: true, force: true});
    process.env = {...originalEnv};
  });

  describe('resolveUseLocalStorage', () => {
    let usageErrors: string[];

    const parse = (args: string[]): Command => {
      usageErrors = [];
      const command = new Command('web')
        .addOption(SESSION_SERVICE_URI_OPTION)
        .addOption(ARTIFACT_SERVICE_URI_OPTION)
        .addOption(USE_LOCAL_STORAGE_OPTION)
        .addOption(NO_USE_LOCAL_STORAGE_OPTION);
      command.exitOverride();
      command.configureOutput({writeErr: (str) => usageErrors.push(str)});
      command.parse(['node', 'web', ...args]);
      return command;
    };

    const expectUsageError = (args: string[]) => {
      const command = parse(args);
      let exitCode: number | undefined;
      try {
        resolveUseLocalStorage(command);
      } catch (error: unknown) {
        if (!(error instanceof Error) || !('exitCode' in error)) {
          throw error;
        }
        exitCode = Number(error.exitCode);
      }
      return {exitCode, message: usageErrors.join('')};
    };

    it.each([
      ['--session_service_uri', ['--use_local_storage']],
      ['--artifact_service_uri', ['--no_use_local_storage']],
    ])('rejects a storage flag with %s', (uriFlag, storageFlag) => {
      const {exitCode, message} = expectUsageError([
        ...storageFlag,
        uriFlag,
        'memory://',
      ]);

      expect(exitCode).toBe(2);
      expect(message).toContain(
        '--use_local_storage/--no_use_local_storage cannot be used with ' +
          '--session_service_uri or --artifact_service_uri.',
      );
    });

    it('allows a memory URI together with a storage flag', () => {
      const command = new Command('web')
        .addOption(SESSION_SERVICE_URI_OPTION)
        .addOption(ARTIFACT_SERVICE_URI_OPTION)
        .addOption(USE_LOCAL_STORAGE_OPTION)
        .addOption(NO_USE_LOCAL_STORAGE_OPTION)
        .addOption(MEMORY_SERVICE_URI_OPTION);
      command.parse([
        'node',
        'web',
        '--use_local_storage',
        '--memory_service_uri',
        'memory://',
      ]);

      expect(resolveUseLocalStorage(command)).toBe(true);
    });

    it('allows a service URI when neither flag was given', () => {
      const command = parse(['--session_service_uri', 'sqlite://sessions.db']);

      expect(resolveUseLocalStorage(command)).toBe(true);
    });

    it.each([
      ['no flag, which defaults to local storage', [], true],
      ['--use_local_storage', ['--use_local_storage'], true],
      ['--no_use_local_storage', ['--no_use_local_storage'], false],
      [
        'both flags, where the negative wins',
        ['--use_local_storage', '--no_use_local_storage'],
        false,
      ],
    ])('resolves %s', (_name, args, expected) => {
      expect(resolveUseLocalStorage(parse(args))).toBe(expected);
    });
  });

  describe('resolveEffectiveLocalStorage', () => {
    it('is disabled by ADK_DISABLE_LOCAL_STORAGE', () => {
      process.env['ADK_DISABLE_LOCAL_STORAGE'] = '1';

      const result = resolveEffectiveLocalStorage(baseDir, true);

      expect(result.enabled).toBe(false);
      expect(result.warning).toContain(
        'Local storage is disabled by ADK_DISABLE_LOCAL_STORAGE',
      );
    });

    it('is forced by ADK_FORCE_LOCAL_STORAGE even when not requested', () => {
      process.env['ADK_FORCE_LOCAL_STORAGE'] = 'true';

      const result = resolveEffectiveLocalStorage(baseDir, false);

      expect(result).toEqual({enabled: true});
    });

    it('gives up when ADK_FORCE_LOCAL_STORAGE points at an unwritable path', () => {
      process.env['ADK_FORCE_LOCAL_STORAGE'] = '1';
      const notADirectory = path.join(baseDir, 'a-file');
      fs.writeFileSync(notADirectory, '', 'utf-8');

      const result = resolveEffectiveLocalStorage(notADirectory, true);

      expect(result.enabled).toBe(false);
      expect(result.warning).toContain(
        'Local storage is forced by ADK_FORCE_LOCAL_STORAGE',
      );
    });

    it('stays off, without a warning, when it was not requested', () => {
      expect(resolveEffectiveLocalStorage(baseDir, false)).toEqual({
        enabled: false,
      });
    });

    it.each([['K_SERVICE'], ['KUBERNETES_SERVICE_HOST']])(
      'falls back to in-memory when %s is set',
      (envVar) => {
        process.env[envVar] = 'some-service';

        const result = resolveEffectiveLocalStorage(baseDir, true);

        expect(result.enabled).toBe(false);
        expect(result.warning).toContain(
          'Detected Cloud Run/Kubernetes runtime',
        );
      },
    );

    it('falls back to in-memory when the directory is missing', () => {
      const result = resolveEffectiveLocalStorage(
        path.join(baseDir, 'absent'),
        true,
      );

      expect(result.enabled).toBe(false);
      expect(result.warning).toContain('is not writable');
    });

    it('is enabled for a writable directory', () => {
      expect(resolveEffectiveLocalStorage(baseDir, true)).toEqual({
        enabled: true,
      });
    });
  });

  describe('closeServices', () => {
    it('closes a service that holds a connection open', async () => {
      const close = vi.spyOn(DatabaseSessionService.prototype, 'close');
      const services = resolveServices({baseDir, useLocalStorage: true});

      await closeServices(services);

      expect(services.sessionService).toBeInstanceOf(DatabaseSessionService);
      expect(close).toHaveBeenCalledOnce();
    });

    it('leaves the services that hold nothing open alone', async () => {
      const services = resolveServices({baseDir, useLocalStorage: false});

      await expect(closeServices(services)).resolves.toBeUndefined();
    });
  });

  describe('resolveServices', () => {
    it('keeps everything in memory when inMemory overrides the URIs', () => {
      const services = resolveServices({
        baseDir,
        sessionServiceUri: 'sqlite://ignored.db',
        artifactServiceUri: 'gs://ignored',
        memoryServiceUri: 'agentengine://123',
        useLocalStorage: true,
        inMemory: true,
      });

      expect(services.sessionService).toBeInstanceOf(InMemorySessionService);
      expect(services.artifactService).toBeInstanceOf(InMemoryArtifactService);
      expect(services.memoryService).toBeInstanceOf(InMemoryMemoryService);
      expect(fs.existsSync(path.join(baseDir, '.adk'))).toBe(false);
    });

    it('lets an explicit URI win over local storage', () => {
      const services = resolveServices({
        baseDir,
        sessionServiceUri: 'memory://',
        artifactServiceUri: 'gs://a-bucket',
        useLocalStorage: true,
      });

      expect(services.sessionService).toBeInstanceOf(InMemorySessionService);
      expect(services.artifactService).not.toBeInstanceOf(
        InMemoryArtifactService,
      );
    });

    it('stores under .adk when local storage is on', () => {
      const services = resolveServices({baseDir, useLocalStorage: true});

      expect(services.sessionService).toBeInstanceOf(DatabaseSessionService);
      expect(services.artifactService).toBeInstanceOf(FileArtifactService);
      expect(fs.existsSync(path.join(baseDir, '.adk'))).toBe(true);
    });

    it('uses in-memory services when local storage is off', () => {
      const services = resolveServices({baseDir, useLocalStorage: false});

      expect(services.sessionService).toBeInstanceOf(InMemorySessionService);
      expect(services.artifactService).toBeInstanceOf(InMemoryArtifactService);
      expect(fs.existsSync(path.join(baseDir, '.adk'))).toBe(false);
    });

    it('reads DATABASE_URL when no session URI is given', () => {
      process.env['DATABASE_URL'] = 'memory://';

      const services = resolveServices({baseDir, useLocalStorage: true});

      expect(services.sessionService).toBeInstanceOf(InMemorySessionService);
      expect(services.artifactService).toBeInstanceOf(FileArtifactService);
    });

    it('builds the memory service from its URI, ignoring local storage', () => {
      process.env['GOOGLE_CLOUD_PROJECT'] = 'placeholder-project';
      process.env['GOOGLE_CLOUD_LOCATION'] = 'us-central1';

      const services = resolveServices({
        baseDir,
        memoryServiceUri: 'agentengine://123',
        useLocalStorage: true,
      });

      expect(services.memoryService).toBeInstanceOf(VertexAiMemoryBankService);
    });

    it('defaults the memory service to in-memory', () => {
      const services = resolveServices({baseDir, useLocalStorage: true});

      expect(services.memoryService).toBeInstanceOf(InMemoryMemoryService);
    });
  });
});
