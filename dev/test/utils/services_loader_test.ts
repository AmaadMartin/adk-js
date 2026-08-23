/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getMemoryServiceFromUri,
  getServiceRegistry,
  getSessionServiceFromUri,
  InMemorySessionService,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {compileFile} from '../../src/utils/agent_loader.js';
import {AdkLogger} from '../../src/utils/logger.js';
import {
  loadServicesModule,
  readExport,
} from '../../src/utils/services_loader.js';

const compiledTempDirs = vi.hoisted(() => [] as string[]);

// The real compile still runs; the spy only records the temp directory it made,
// so a test can assert that directory is gone afterwards.
vi.mock('../../src/utils/agent_loader.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/utils/agent_loader.js')>();

  return {
    ...original,
    compileFile: vi.fn(async (filePath: string, options) => {
      const compiled = await original.compileFile(filePath, options);
      compiledTempDirs.push(compiled.tempDirPath);

      return compiled;
    }),
  };
});

const registry = getServiceRegistry();

let dir: string;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_services_loader_test_'));
  compiledTempDirs.length = 0;
  vi.mocked(compileFile).mockClear();
  warn = vi.spyOn(AdkLogger.prototype, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, {recursive: true, force: true});
});

/** Writes a `services` module into the temp directory. */
async function writeServices(fileName: string, body: string): Promise<void> {
  await fs.writeFile(path.join(dir, fileName), body, 'utf8');
}

async function exists(dirPath: string): Promise<boolean> {
  try {
    await fs.stat(dirPath);

    return true;
  } catch {
    return false;
  }
}

describe('loadServicesModule', () => {
  it('registers a session factory from services.js', async () => {
    await writeServices(
      'services.js',
      `export const services = {
         session: {mysession: (uri) => ({kind: 'session', uri})},
       };`,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('mysession://x')).toEqual({
      kind: 'session',
      uri: 'mysession://x',
    });
  });

  it('registers an artifact factory from services.ts', async () => {
    await writeServices(
      'services.ts',
      `interface Built {kind: string; uri: string}
       export const services = {
         artifact: {
           myartifact: (uri: string): Built => ({kind: 'artifact', uri}),
         },
       };`,
    );

    await loadServicesModule(dir);

    expect(registry.createArtifactService('myartifact://x')).toEqual({
      kind: 'artifact',
      uri: 'myartifact://x',
    });
  });

  it('reads the default export when there is no named services export', async () => {
    await writeServices(
      'services.js',
      `export default {
         memory: {mydefaultmemory: (uri) => ({kind: 'memory', uri})},
       };`,
    );

    await loadServicesModule(dir);

    expect(registry.createMemoryService('mydefaultmemory://x')).toEqual({
      kind: 'memory',
      uri: 'mydefaultmemory://x',
    });
  });

  it('forwards the factory options to a registered factory', async () => {
    await writeServices(
      'services.js',
      `export const services = {
         session: {myoptions: (uri, options) => ({uri, options})},
       };`,
    );

    await loadServicesModule(dir);

    expect(
      registry.createSessionService('myoptions://x', {agentsDir: '/agents'}),
    ).toEqual({uri: 'myoptions://x', options: {agentsDir: '/agents'}});
  });

  it('loads the services module beside an agent file', async () => {
    await writeServices(
      'services.js',
      `export const services = {
         session: {mysibling: (uri) => ({uri})},
       };`,
    );
    const agentFile = path.join(dir, 'agent.js');
    await fs.writeFile(agentFile, 'export const rootAgent = {};', 'utf8');

    await loadServicesModule(agentFile);

    expect(registry.createSessionService('mysibling://x')).toEqual({
      uri: 'mysibling://x',
    });
  });

  it('prefers .js over .ts when both are present', async () => {
    await writeServices(
      'services.js',
      `export const services = {
         session: {myprecedence: () => ({from: 'js'})},
       };`,
    );
    await writeServices(
      'services.ts',
      `export const services = {
         session: {myprecedence: () => ({from: 'ts'})},
       };`,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('myprecedence://x')).toEqual({
      from: 'js',
    });
  });

  it('registers nothing and does not throw without a services module', async () => {
    await expect(loadServicesModule(dir)).resolves.toBeUndefined();

    expect(registry.createSessionService('mymissing://x')).toBeUndefined();
    expect(compileFile).not.toHaveBeenCalled();
  });

  it('registers nothing and does not throw for a missing directory', async () => {
    await expect(
      loadServicesModule(path.join(dir, 'absent')),
    ).resolves.toBeUndefined();

    expect(compileFile).not.toHaveBeenCalled();
  });

  it('warns instead of throwing when the module throws at import time', async () => {
    await writeServices(
      'services.js',
      `throw new Error('boom from the user module');`,
    );

    await expect(loadServicesModule(dir)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('boom from the user module'),
    );
  });

  it('warns when the module throws something that is not an Error', async () => {
    await writeServices('services.js', `throw 'a bare string, not an Error';`);

    await expect(loadServicesModule(dir)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('a bare string, not an Error'),
    );
  });

  it('warns when the module exports no registrations object', async () => {
    await writeServices('services.js', `export const unrelated = 1;`);

    await loadServicesModule(dir);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exports no'));
  });

  it('skips an entry that is not a function and keeps its valid sibling', async () => {
    await writeServices(
      'services.js',
      `export const services = {
         session: {
           mybroken: 'not-a-function',
           myvalid: (uri) => ({uri}),
         },
       };`,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('mybroken://x')).toBeUndefined();
    expect(registry.createSessionService('myvalid://x')).toEqual({
      uri: 'myvalid://x',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Invalid session service registration for 'mybroken'",
      ),
    );
  });

  it('names the service kind of an invalid artifact and memory entry', async () => {
    await writeServices(
      'services.js',
      `export const services = {
         artifact: {mybadartifact: 1},
         memory: {mybadmemory: null},
       };`,
    );

    await loadServicesModule(dir);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Invalid artifact service registration for 'mybadartifact'",
      ),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "Invalid memory service registration for 'mybadmemory'",
      ),
    );
  });

  it('removes the compile temp directory afterwards', async () => {
    await writeServices(
      'services.ts',
      `export const services = {session: {mytempdir: () => ({})}};`,
    );

    await loadServicesModule(dir);

    expect(compiledTempDirs).toHaveLength(1);
    expect(await exists(compiledTempDirs[0])).toBe(false);
  });

  it('removes the compile temp directory when the import fails', async () => {
    await writeServices('services.ts', `throw new Error('boom');`);

    await loadServicesModule(dir);

    expect(compiledTempDirs).toHaveLength(1);
    expect(await exists(compiledTempDirs[0])).toBe(false);
  });

  it('imports the module directly when compiling is disabled', async () => {
    await writeServices(
      'services.mjs',
      `export const services = {session: {mynocompile: (uri) => ({uri})}};`,
    );

    await loadServicesModule(dir, {compile: false, bundle: false});

    expect(registry.createSessionService('mynocompile://x')).toEqual({
      uri: 'mynocompile://x',
    });
    expect(compileFile).not.toHaveBeenCalled();
  });

  it('registers all three service kinds from one module', async () => {
    await writeServices(
      'services.js',
      `export const services = {
         session: {myall: () => ({kind: 'session'})},
         artifact: {myall: () => ({kind: 'artifact'})},
         memory: {myall: () => ({kind: 'memory'})},
       };`,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('myall://x')).toEqual({
      kind: 'session',
    });
    expect(registry.createArtifactService('myall://x')).toEqual({
      kind: 'artifact',
    });
    expect(registry.createMemoryService('myall://x')).toEqual({
      kind: 'memory',
    });
  });
});

describe('readExport', () => {
  it('reads a name a CommonJS module exposes only under default', () => {
    class YamlNested {}

    expect(readExport({default: {YamlNested}}, 'YamlNested')).toBe(YamlNested);
  });

  it('prefers a name the module exports directly', () => {
    class Direct {}
    class Nested {}

    expect(readExport({Named: Direct, default: {Named: Nested}}, 'Named')).toBe(
      Direct,
    );
  });

  it('returns undefined when neither place has the name', () => {
    expect(readExport({default: 'not a record'}, 'Absent')).toBeUndefined();
  });
});

describe('loadServicesModule from services.yaml', () => {
  it('registers a session backend named by a relative module', async () => {
    await writeServices(
      'yaml_session.js',
      `export class YamlSession {
         constructor(uri) {
           this.uri = uri;
         }
       }`,
    );
    await writeServices(
      'services.yaml',
      `services:
         - scheme: yamlsession
           type: session
           module: ./yaml_session.js
           class: YamlSession
      `,
    );

    await loadServicesModule(dir);

    expect(
      registry.createSessionService('yamlsession://host/db'),
    ).toMatchObject({uri: 'yamlsession://host/db'});
  });

  it('resolves a declared scheme through the public session resolver', async () => {
    await writeServices(
      'yaml_public.js',
      `export class YamlPublic {
         constructor(uri) {
           this.uri = uri;
         }
       }`,
    );
    await writeServices(
      'services.yaml',
      `services:
         - scheme: yamlpublic
           type: session
           module: ./yaml_public.js
           class: YamlPublic
      `,
    );

    await loadServicesModule(dir);

    expect(getSessionServiceFromUri('yamlpublic://host/db')).toMatchObject({
      uri: 'yamlpublic://host/db',
    });
  });

  it('registers a memory backend and resolves it through its resolver', async () => {
    await writeServices(
      'yaml_memory.js',
      `export class YamlMemory {
         constructor(uri) {
           this.uri = uri;
         }
       }`,
    );
    await writeServices(
      'services.yaml',
      `services:
         - scheme: yamlmemory
           type: memory
           module: ./yaml_memory.js
           class: YamlMemory
      `,
    );

    await loadServicesModule(dir);

    expect(getMemoryServiceFromUri('yamlmemory://bank')).toMatchObject({
      uri: 'yamlmemory://bank',
    });
  });

  it('registers an artifact backend', async () => {
    await writeServices(
      'yaml_artifact.js',
      `export class YamlArtifact {
         constructor(uri) {
           this.uri = uri;
         }
       }`,
    );
    await writeServices(
      'services.yaml',
      `services:
         - scheme: yamlartifact
           type: artifact
           module: ./yaml_artifact.js
           class: YamlArtifact
      `,
    );

    await loadServicesModule(dir);

    expect(registry.createArtifactService('yamlartifact://b')).toMatchObject({
      uri: 'yamlartifact://b',
    });
  });

  it('constructs the default export when the entry names no class', async () => {
    await writeServices(
      'yaml_default.js',
      `export default class YamlDefault {
         constructor(uri) {
           this.uri = uri;
         }
       }`,
    );
    await writeServices(
      'services.yaml',
      `services:
         - scheme: yamldefault
           type: session
           module: ./yaml_default.js
      `,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('yamldefault://x')).toMatchObject({
      uri: 'yamldefault://x',
    });
  });

  it('reads a class the CommonJS module nests under its default export', async () => {
    await writeServices(
      'yaml_nested.cjs',
      // A computed key hides the export from Node's CommonJS lexer, which is
      // what leaves the class reachable only under the default export.
      `const exported = {};
       exported[['Yaml', 'Nested'].join('')] = class {
         constructor(uri) {
           this.uri = uri;
         }
       };
       module.exports = exported;`,
    );
    await writeServices(
      'services.yaml',
      `services:
         - scheme: yamlnested
           type: session
           module: ./yaml_nested.cjs
           class: YamlNested
      `,
    );

    await loadServicesModule(dir, {compile: false, bundle: false});

    expect(registry.createSessionService('yamlnested://x')).toMatchObject({
      uri: 'yamlnested://x',
    });
  });

  it('compiles a TypeScript backend and removes the temp directory', async () => {
    await writeServices(
      'yaml_typescript.ts',
      `export class YamlTypescript {
         readonly uri: string;

         constructor(uri: string) {
           this.uri = uri;
         }
       }`,
    );
    await writeServices(
      'services.yaml',
      `services:
         - scheme: yamltypescript
           type: session
           module: ./yaml_typescript.ts
           class: YamlTypescript
      `,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('yamltypescript://x')).toMatchObject({
      uri: 'yamltypescript://x',
    });
    expect(compiledTempDirs).toHaveLength(1);
    expect(await exists(compiledTempDirs[0])).toBe(false);
  });

  it('resolves an absolute module path', async () => {
    await writeServices(
      'yaml_absolute.js',
      `export class YamlAbsolute {
         constructor(uri) {
           this.uri = uri;
         }
       }`,
    );
    await writeServices(
      'services.yaml',
      `services:
         - scheme: yamlabsolute
           type: session
           module: ${path.join(dir, 'yaml_absolute.js')}
           class: YamlAbsolute
      `,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('yamlabsolute://x')).toMatchObject({
      uri: 'yamlabsolute://x',
    });
  });

  it('resolves a package name from the directory node_modules', async () => {
    const packageDir = path.join(dir, 'node_modules', 'yaml-backend');
    await fs.mkdir(packageDir, {recursive: true});
    await fs.writeFile(
      path.join(packageDir, 'package.json'),
      '{"name": "yaml-backend", "type": "module", "main": "index.js"}',
      'utf8',
    );
    await fs.writeFile(
      path.join(packageDir, 'index.js'),
      `export class YamlPackage {
         constructor(uri) {
           this.uri = uri;
         }
       }`,
      'utf8',
    );
    await writeServices(
      'services.yaml',
      `services:
         - scheme: yamlpackage
           type: session
           module: yaml-backend
           class: YamlPackage
      `,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('yamlpackage://x')).toMatchObject({
      uri: 'yamlpackage://x',
    });
  });

  it('loads services.yml as well as services.yaml', async () => {
    await writeServices(
      'yaml_both.js',
      `export class YamlBoth {
         constructor(uri) {
           this.uri = uri;
         }
       }`,
    );
    await writeServices(
      'services.yaml',
      `services:
         - scheme: yamlfromyaml
           type: session
           module: ./yaml_both.js
           class: YamlBoth
      `,
    );
    await writeServices(
      'services.yml',
      `services:
         - scheme: yamlfromyml
           type: session
           module: ./yaml_both.js
           class: YamlBoth
      `,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('yamlfromyaml://x')).toBeDefined();
    expect(registry.createSessionService('yamlfromyml://x')).toBeDefined();
  });

  it('lets the services module override a scheme the config declares', async () => {
    await writeServices(
      'yaml_override.js',
      `export class YamlOverride {
         constructor(uri) {
           this.from = 'yaml';
         }
       }`,
    );
    await writeServices(
      'services.yaml',
      `services:
         - scheme: yamloverride
           type: session
           module: ./yaml_override.js
           class: YamlOverride
      `,
    );
    await writeServices(
      'services.js',
      `export const services = {
         session: {yamloverride: () => ({from: 'module'})},
       };`,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('yamloverride://x')).toEqual({
      from: 'module',
    });
  });

  it('skips an unknown type and a module-less entry, keeping the sibling', async () => {
    await writeServices(
      'yaml_sibling.js',
      `export class YamlSibling {
         constructor(uri) {
           this.uri = uri;
         }
       }`,
    );
    await writeServices(
      'services.yaml',
      `services:
         - scheme: yamltaskstore
           type: task_store
           module: ./yaml_sibling.js
           class: YamlSibling
         - scheme: yamlnomodule
           type: session
           module: ''
         - just a string, not a mapping
         - scheme: yamlsibling
           type: session
           module: ./yaml_sibling.js
           class: YamlSibling
      `,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('yamltaskstore://x')).toBeUndefined();
    expect(registry.createSessionService('yamlnomodule://x')).toBeUndefined();
    expect(registry.createSessionService('yamlsibling://x')).toMatchObject({
      uri: 'yamlsibling://x',
    });
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('it needs a scheme, a module, and a type of'),
    );
  });

  it('skips an entry whose module exports no such class', async () => {
    await writeServices('yaml_missing_class.js', `export const unrelated = 1;`);
    await writeServices(
      'services.yaml',
      `services:
         - scheme: yamlmissingclass
           type: session
           module: ./yaml_missing_class.js
           class: Absent
      `,
    );

    await loadServicesModule(dir);

    expect(
      registry.createSessionService('yamlmissingclass://x'),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("exports no 'Absent' class"),
    );
  });

  it('names the default export when a class-less entry has none', async () => {
    await writeServices('yaml_no_default.js', `export const unrelated = 1;`);
    await writeServices(
      'services.yaml',
      `services:
         - scheme: yamlnodefault
           type: session
           module: ./yaml_no_default.js
      `,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('yamlnodefault://x')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("exports no 'default' class"),
    );
  });

  it('warns when the config file is empty', async () => {
    await writeServices('services.yaml', '');

    await loadServicesModule(dir);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("declares no 'services' list"),
    );
  });

  it('skips an entry whose module cannot be resolved, keeping the sibling', async () => {
    await writeServices(
      'yaml_after_broken.js',
      `export class YamlAfterBroken {
         constructor(uri) {
           this.uri = uri;
         }
       }`,
    );
    await writeServices(
      'services.yaml',
      `services:
         - scheme: yamlunresolvable
           type: session
           module: no-such-package-anywhere
         - scheme: yamlafterbroken
           type: session
           module: ./yaml_after_broken.js
           class: YamlAfterBroken
      `,
    );

    await loadServicesModule(dir);

    expect(
      registry.createSessionService('yamlunresolvable://x'),
    ).toBeUndefined();
    expect(registry.createSessionService('yamlafterbroken://x')).toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Skipping 'yamlunresolvable'"),
    );
  });

  it('warns when the config declares no services list', async () => {
    await writeServices('services.yaml', 'unrelated: true\n');

    await loadServicesModule(dir);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("declares no 'services' list"),
    );
  });

  it('does not load the services module when the config is unparseable', async () => {
    await writeServices('services.yaml', 'services: [unclosed\n');
    await writeServices(
      'services.js',
      `export const services = {
         session: {yamlunparseable: () => ({})},
       };`,
    );

    await expect(loadServicesModule(dir)).resolves.toBeUndefined();

    expect(
      registry.createSessionService('yamlunparseable://x'),
    ).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read'),
    );
  });
});

describe('the documented services.yaml example', () => {
  // The samples import '@google/adk', so the fixture needs the resolution a
  // real agent directory has: a package.json and the project's node_modules.
  beforeEach(async () => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      '{"name": "guide-fixture", "type": "module"}',
      'utf8',
    );
    await fs.symlink(
      fileURLToPath(new URL('../../../node_modules', import.meta.url)),
      path.join(dir, 'node_modules'),
      'dir',
    );
  });

  const backend = `import {InMemorySessionService} from '@google/adk';

     export class MySessionService extends InMemorySessionService {
       constructor(uri) {
         super();
         this.uri = uri;
       }
     }`;

  it('serves sessions from the TypeScript class the config names', async () => {
    await writeServices('my_session_service.ts', backend);
    await writeServices(
      'services.yaml',
      `services:
         - scheme: mysession
           type: session
           module: ./my_session_service.ts
           class: MySessionService
      `,
    );

    await loadServicesModule(dir);
    const service = getSessionServiceFromUri('mysession://host/db');
    const session = await service.createSession({
      appName: 'guide_app',
      userId: 'guide_user',
    });

    expect(service).toMatchObject({uri: 'mysession://host/db'});
    expect(session.appName).toBe('guide_app');
    expect(
      await service.getSession({
        appName: 'guide_app',
        userId: 'guide_user',
        sessionId: session.id,
      }),
    ).toMatchObject({id: session.id});
    // The CLI's default options bundle the SDK into the module, which is slow.
  }, 60000);

  it('skips a TypeScript source the entry names with a .js extension', async () => {
    await writeServices('my_rewritten_service.ts', backend);
    await writeServices(
      'services.yaml',
      `services:
         - scheme: myrewritten
           type: session
           module: ./my_rewritten_service.js
           class: MySessionService
      `,
    );

    await loadServicesModule(dir);

    expect(registry.createSessionService('myrewritten://x')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Skipping 'myrewritten'"),
    );
    // Long enough that a resolver which did compile the source would fail on
    // the assertion rather than on the clock.
  }, 60000);

  it('serves sessions from the factory the services module exports', async () => {
    await writeServices('my_module_session_service.js', backend);
    await writeServices(
      'services.js',
      `import {MySessionService} from './my_module_session_service.js';

       export const services = {
         session: {mymodulesession: (uri) => new MySessionService(uri)},
       };`,
    );

    await loadServicesModule(dir);
    const service = getSessionServiceFromUri('mymodulesession://host/db');
    const session = await service.createSession({
      appName: 'guide_module_app',
      userId: 'guide_user',
    });

    expect(service).toMatchObject({uri: 'mymodulesession://host/db'});
    expect(session.appName).toBe('guide_module_app');
    // The CLI's default options bundle the SDK into the module, which is slow.
  }, 60000);

  it('serves sessions from a factory registered in process', async () => {
    registry.registerSessionService(
      'myinprocess',
      () => new InMemorySessionService(),
    );

    expect(getSessionServiceFromUri('myinprocess://host/db')).toBeInstanceOf(
      InMemorySessionService,
    );
  });
});
