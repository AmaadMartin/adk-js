/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Every case here writes real files into a temp directory and lets
// loadServicesModule read them, so the YAML parsing, the dynamic import and the
// TypeScript compilation are the real ones.
//
// A fixture script imports the module under test by its absolute source path.
// That is the same import a user's services script writes as
// `from '@google/adk-devtools'`, and taking the source path keeps the script
// and the test on one registry instance.

import {EventEmitter} from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  getServiceRegistry,
  loadServicesModule,
} from '../../src/cli/service_registry.js';
import {createTempDir} from '../../src/utils/file_utils.js';
import {AdkLogger} from '../../src/utils/logger.js';

const REGISTRY_SOURCE = fileURLToPath(
  new URL('../../src/cli/service_registry.ts', import.meta.url),
);

/** A session service class a `class:` field can name. */
const SERVICE_CLASS_SOURCE = `
export class DemoSessionService {
  constructor(options) {
    this.uri = options.uri;
  }
}
export default DemoSessionService;
`;

/** Registers \`scheme\` against the registry the test also reads. */
function scriptSource(scheme: string): string {
  return `
import {getServiceRegistry} from ${JSON.stringify(REGISTRY_SOURCE)};

getServiceRegistry().registerSessionService(
  '${scheme}',
  (uri) => ({fromScript: uri}),
);
`;
}

function yamlSource(scheme: string, type = 'session'): string {
  return `services:
  - scheme: ${scheme}
    type: ${type}
    class: './demo_service.js#DemoSessionService'
`;
}

describe('loadServicesModule', () => {
  let dir = '';
  let warnings: string[] = [];

  beforeEach(async () => {
    dir = await createTempDir('adk_services_loading_test');
    warnings = [];
    vi.spyOn(AdkLogger.prototype, 'warn').mockImplementation(
      (...messages: unknown[]) => {
        warnings.push(messages.join(' '));
      },
    );
  });

  afterEach(async () => {
    await fs.rm(dir, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  async function write(name: string, contents: string): Promise<void> {
    await fs.writeFile(path.join(dir, name), contents, {encoding: 'utf-8'});
  }

  async function writeServiceClass(): Promise<void> {
    await write('demo_service.js', SERVICE_CLASS_SOURCE);
  }

  it('does nothing when the directory does not exist', async () => {
    await loadServicesModule(path.join(dir, 'absent'));

    expect(warnings).toEqual([]);
  });

  it('does nothing when the directory declares no services', async () => {
    await loadServicesModule(dir);

    expect(warnings).toEqual([]);
  });

  it('registers a scheme declared in services.yaml', async () => {
    await writeServiceClass();
    await write('services.yaml', yamlSource('yamlonly'));

    await loadServicesModule(dir);

    const service =
      await getServiceRegistry().createSessionService('yamlonly://host/db');
    expect(service).toMatchObject({uri: 'yamlonly://host/db'});
  });

  it('registers a scheme declared in services.yml', async () => {
    await writeServiceClass();
    await write('services.yml', yamlSource('ymlonly'));

    await loadServicesModule(dir);

    expect(
      await getServiceRegistry().createSessionService('ymlonly://x'),
    ).toBeDefined();
  });

  it('applies both services.yaml and services.yml when both are present', async () => {
    await writeServiceClass();
    await write('services.yaml', yamlSource('bothyaml'));
    await write('services.yml', yamlSource('bothyml'));

    await loadServicesModule(dir);

    expect(
      await getServiceRegistry().createSessionService('bothyaml://x'),
    ).toBeDefined();
    expect(
      await getServiceRegistry().createSessionService('bothyml://x'),
    ).toBeDefined();
  });

  it('registers an artifact scheme and a memory scheme', async () => {
    await writeServiceClass();
    await write(
      'services.yaml',
      `${yamlSource('artifactkind', 'artifact')}${yamlSource('memorykind', 'memory').replace('services:\n', '')}`,
    );

    await loadServicesModule(dir);

    expect(
      await getServiceRegistry().createArtifactService('artifactkind://x'),
    ).toBeDefined();
    expect(
      await getServiceRegistry().createMemoryService('memorykind://x'),
    ).toBeDefined();
  });

  it('uses the default export when the class names no export', async () => {
    await writeServiceClass();
    await write(
      'services.yaml',
      `services:
  - scheme: defaultexport
    type: session
    class: './demo_service.js'
`,
    );

    await loadServicesModule(dir);

    expect(
      await getServiceRegistry().createSessionService('defaultexport://x'),
    ).toBeDefined();
  });

  it('resolves a class named by a package specifier', async () => {
    // node:events stands in for a published backend package: the point is that
    // a specifier with no leading dot goes to the module resolver, not to a
    // file beside the YAML.
    await write(
      'services.yaml',
      `services:
  - scheme: packageclass
    type: session
    class: 'node:events#EventEmitter'
`,
    );

    await loadServicesModule(dir);

    expect(
      await getServiceRegistry().createSessionService('packageclass://x'),
    ).toBeInstanceOf(EventEmitter);
  });

  it('warns and skips an entry that declares no class', async () => {
    await write(
      'services.yaml',
      `services:
  - scheme: noclass
    type: session
`,
    );

    await loadServicesModule(dir);

    expect(warnings.join('\n')).toContain('Invalid service config in YAML');
    expect(await getServiceRegistry().createSessionService('noclass://x')).toBe(
      undefined,
    );
  });

  it('warns and skips an entry whose type is not a service kind', async () => {
    await writeServiceClass();
    await write('services.yaml', yamlSource('taskstore', 'task_store'));

    await loadServicesModule(dir);

    expect(warnings.join('\n')).toContain(
      'Unknown service type in YAML: task_store',
    );
    expect(
      await getServiceRegistry().createSessionService('taskstore://x'),
    ).toBe(undefined);
  });

  it('ignores a document that declares no services list', async () => {
    await write('services.yaml', 'other: value\n');

    await loadServicesModule(dir);

    expect(warnings).toEqual([]);
  });

  it('warns and leaves the script alone when the YAML cannot be parsed', async () => {
    await write('services.yaml', 'services: [\n  - broken: "');
    await write('services.js', scriptSource('afterbadyaml'));

    await loadServicesModule(dir);

    expect(warnings.join('\n')).toContain('Failed to load');
    expect(
      await getServiceRegistry().createSessionService('afterbadyaml://x'),
    ).toBe(undefined);
  });

  it('warns and leaves the script alone when a declared class is missing', async () => {
    await write(
      'services.yaml',
      `services:
  - scheme: absentclass
    type: session
    class: './not_here.js#Missing'
`,
    );
    await write('services.js', scriptSource('afterbadclass'));

    await loadServicesModule(dir);

    expect(warnings.join('\n')).toContain('Failed to load');
    expect(
      await getServiceRegistry().createSessionService('afterbadclass://x'),
    ).toBe(undefined);
  });

  it('warns when the declared export is not a constructor', async () => {
    await write('demo_service.js', 'export const NotAClass = 7;\n');
    await write(
      'services.yaml',
      `services:
  - scheme: notaclass
    type: session
    class: './demo_service.js#NotAClass'
`,
    );

    await loadServicesModule(dir);

    expect(warnings.join('\n')).toContain('does not name a constructor');
  });

  it('registers a scheme declared in services.js', async () => {
    await write('services.js', scriptSource('scriptonly'));

    await loadServicesModule(dir);

    expect(
      await getServiceRegistry().createSessionService('scriptonly://x'),
    ).toMatchObject({fromScript: 'scriptonly://x'});
  });

  it('registers a scheme declared in a TypeScript services file', async () => {
    await write(
      'services.ts',
      `${scriptSource('scripttypescript')}
const scheme: string = 'scripttypescript';
export type Declared = typeof scheme;
`,
    );

    await loadServicesModule(dir);

    expect(
      await getServiceRegistry().createSessionService('scripttypescript://x'),
    ).toBeDefined();
  });

  it('lets the script replace a scheme the YAML declared', async () => {
    await writeServiceClass();
    await write('services.yaml', yamlSource('duplicated'));
    await write('services.js', scriptSource('duplicated'));

    await loadServicesModule(dir);

    expect(
      await getServiceRegistry().createSessionService('duplicated://x'),
    ).toMatchObject({fromScript: 'duplicated://x'});
  });

  it('warns and continues when the script throws', async () => {
    await write('services.js', 'throw new Error("script blew up");\n');

    await loadServicesModule(dir);

    expect(warnings.join('\n')).toContain('script blew up');
  });

  it('warns when the script throws something that is not an Error', async () => {
    await write('services.js', 'throw "a bare string";\n');

    await loadServicesModule(dir);

    expect(warnings.join('\n')).toContain('a bare string');
  });
});
