/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';
import {
  getServiceRegistry,
  loadServicesModule,
  ServiceRegistry,
} from '../../src/cli/service_registry.js';
import {AdkLogger} from '../../src/utils/logger.js';

/**
 * A session service written the way a user would write one: a class taking the
 * URI, reporting it back through the service contract.
 */
const SESSION_SERVICE_SOURCE = `
export class Sessions {
  constructor(uri) {
    this.uri = uri;
  }
  async createSession() {
    return {id: this.uri, appName: 'a', userId: 'u', state: {}, events: []};
  }
  async getSession() {
    return undefined;
  }
  async listSessions() {
    return {sessions: []};
  }
  async deleteSession() {}
}
export default Sessions;
`;

const ARTIFACT_SERVICE_SOURCE = `
export class Artifacts {
  constructor(uri) {
    this.uri = uri;
  }
  async saveArtifact() {
    return 0;
  }
  async loadArtifact() {
    return undefined;
  }
  async listArtifactKeys() {
    return [this.uri];
  }
  async deleteArtifact() {}
}
`;

describe('service registry', () => {
  let agentRoot: string;
  let registry: ServiceRegistry;
  let warn: MockInstance<AdkLogger['warn']>;

  beforeEach(async () => {
    agentRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-agent-root-'));
    // The fixture declares its module type, so a `.js` services file is ESM on
    // every supported Node version, not only where module detection is on.
    await fs.writeFile(
      path.join(agentRoot, 'package.json'),
      '{"type": "module"}',
      'utf-8',
    );
    registry = new ServiceRegistry();
    warn = vi
      .spyOn(AdkLogger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(agentRoot, {recursive: true, force: true});
  });

  const write = async (name: string, contents: string) => {
    await fs.writeFile(path.join(agentRoot, name), contents, 'utf-8');
  };

  const warnings = () =>
    warn.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');

  const sessionIdFor = async (uri: string) => {
    const service = registry.createSessionService(uri);
    if (!service) {
      expect.fail(`no session service was registered for ${uri}`);
    }
    const session = await service.createSession({appName: 'a', userId: 'u'});
    return session.id;
  };

  describe('getServiceRegistry', () => {
    it('returns the same registry every time', () => {
      expect(getServiceRegistry()).toBe(getServiceRegistry());
    });
  });

  describe('loadServicesModule', () => {
    it('does nothing for a directory that does not exist', async () => {
      await loadServicesModule(path.join(agentRoot, 'absent'), registry);

      expect(registry.createSessionService('mysession://x')).toBeUndefined();
      expect(warnings()).toBe('');
    });

    it('does nothing for an agent root holding only services.py', async () => {
      await write('services.py', 'print("ignored")\n');

      await loadServicesModule(agentRoot, registry);

      expect(registry.createSessionService('mysession://x')).toBeUndefined();
      expect(warnings()).toBe('');
    });
  });

  describe('services.yaml', () => {
    it('registers a session scheme and an artifact scheme', async () => {
      await write('sessions.mjs', SESSION_SERVICE_SOURCE);
      await write('artifacts.mjs', ARTIFACT_SERVICE_SOURCE);
      await write(
        'services.yaml',
        `services:
  - scheme: mysession
    type: session
    module: ./sessions.mjs
    export: Sessions
  - scheme: myartifact
    type: artifact
    module: ./artifacts.mjs
    export: Artifacts
`,
      );

      await loadServicesModule(agentRoot, registry);

      expect(await sessionIdFor('mysession://demo')).toBe('mysession://demo');
      const artifacts = registry.createArtifactService('myartifact://bucket');
      if (!artifacts) {
        expect.fail('no artifact service was registered');
      }
      expect(
        await artifacts.listArtifactKeys({
          appName: 'a',
          userId: 'u',
          sessionId: 's',
        }),
      ).toEqual(['myartifact://bucket']);
    });

    it('falls back to the default export when no export is named', async () => {
      await write('sessions.mjs', SESSION_SERVICE_SOURCE);
      await write(
        'services.yaml',
        `services:
  - scheme: mysession
    type: session
    module: ./sessions.mjs
`,
      );

      await loadServicesModule(agentRoot, registry);

      expect(await sessionIdFor('mysession://demo')).toBe('mysession://demo');
    });

    it('reads services.yml when services.yaml is absent', async () => {
      await write('sessions.mjs', SESSION_SERVICE_SOURCE);
      await write(
        'services.yml',
        `services:
  - scheme: fromyml
    type: session
    module: ./sessions.mjs
    export: Sessions
`,
      );

      await loadServicesModule(agentRoot, registry);

      expect(await sessionIdFor('fromyml://demo')).toBe('fromyml://demo');
    });

    it('stops before the services module when the YAML cannot be parsed', async () => {
      await write('services.yaml', 'services: [\n  - scheme: "unclosed\n');
      await write(
        'services.js',
        `export const services = [
  {scheme: 'frommodule', type: 'session', create: () => ({})},
];
`,
      );

      await loadServicesModule(agentRoot, registry);

      expect(warnings()).toContain('services.yaml');
      expect(registry.createSessionService('frommodule://x')).toBeUndefined();
    });

    it('skips an entry with no scheme and keeps its siblings', async () => {
      await write('sessions.mjs', SESSION_SERVICE_SOURCE);
      await write(
        'services.yaml',
        `services:
  - type: session
    module: ./sessions.mjs
    export: Sessions
  - scheme: good
    type: session
    module: ./sessions.mjs
    export: Sessions
`,
      );

      await loadServicesModule(agentRoot, registry);

      expect(warnings()).toContain('Invalid service entry');
      expect(await sessionIdFor('good://demo')).toBe('good://demo');
    });

    it('skips an entry with no module', async () => {
      await write(
        'services.yaml',
        `services:
  - scheme: nomodule
    type: session
`,
      );

      await loadServicesModule(agentRoot, registry);

      expect(warnings()).toContain('Invalid service entry');
      expect(registry.createSessionService('nomodule://x')).toBeUndefined();
    });

    it('skips an entry that is not an object', async () => {
      await write('services.yaml', 'services:\n  - just-a-string\n');

      await loadServicesModule(agentRoot, registry);

      expect(warnings()).toContain('Invalid service entry');
    });

    it('skips an entry naming a type it cannot serve', async () => {
      await write('sessions.mjs', SESSION_SERVICE_SOURCE);
      await write(
        'services.yaml',
        `services:
  - scheme: mymemory
    type: memory
    module: ./sessions.mjs
    export: Sessions
`,
      );

      await loadServicesModule(agentRoot, registry);

      expect(warnings()).toContain('Unknown service type');
    });

    it('skips an entry whose module cannot be imported', async () => {
      await write(
        'services.yaml',
        `services:
  - scheme: missing
    type: session
    module: ./not_here.mjs
    export: Sessions
`,
      );

      await loadServicesModule(agentRoot, registry);

      expect(warnings()).toContain('Failed to load');
      expect(registry.createSessionService('missing://x')).toBeUndefined();
    });

    it('skips an entry naming an export the module does not have', async () => {
      await write('sessions.mjs', SESSION_SERVICE_SOURCE);
      await write(
        'services.yaml',
        `services:
  - scheme: absent
    type: session
    module: ./sessions.mjs
    export: NotThere
`,
      );

      await loadServicesModule(agentRoot, registry);

      expect(warnings()).toContain('exports no constructor named "NotThere"');
      expect(registry.createSessionService('absent://x')).toBeUndefined();
    });

    it('ignores a file that declares no services list', async () => {
      await write('services.yaml', 'other: 1\n');

      await loadServicesModule(agentRoot, registry);

      expect(warnings()).toBe('');
    });

    it('reports a class that does not implement the service it claims', async () => {
      await write(
        'wrong.mjs',
        'export class Wrong {}\nexport default Wrong;\n',
      );
      await write(
        'services.yaml',
        `services:
  - scheme: wrong
    type: session
    module: ./wrong.mjs
    export: Wrong
`,
      );

      await loadServicesModule(agentRoot, registry);

      expect(() => registry.createSessionService('wrong://x')).toThrow(
        'did not produce a session service',
      );
    });

    it('reports an artifact class that does not implement the service', async () => {
      await write('wrong.mjs', 'export class Wrong {}\n');
      await write(
        'services.yaml',
        `services:
  - scheme: wrong
    type: artifact
    module: ./wrong.mjs
    export: Wrong
`,
      );

      await loadServicesModule(agentRoot, registry);

      expect(() => registry.createArtifactService('wrong://x')).toThrow(
        'did not produce an artifact service',
      );
    });
  });

  describe('services module', () => {
    it('registers the entries a services.js exports as "services"', async () => {
      await write(
        'services.js',
        `import {Sessions} from './sessions.mjs';
export const services = [
  {scheme: 'frommodule', type: 'session', create: (uri) => new Sessions(uri)},
];
`,
      );
      await write('sessions.mjs', SESSION_SERVICE_SOURCE);

      await loadServicesModule(agentRoot, registry);

      expect(await sessionIdFor('frommodule://demo')).toBe('frommodule://demo');
    });

    it('accepts the default export', async () => {
      await write('sessions.mjs', SESSION_SERVICE_SOURCE);
      await write(
        'services.js',
        `import {Sessions} from './sessions.mjs';
export default [
  {scheme: 'bydefault', type: 'session', create: (uri) => new Sessions(uri)},
];
`,
      );

      await loadServicesModule(agentRoot, registry);

      expect(await sessionIdFor('bydefault://demo')).toBe('bydefault://demo');
    });

    it('compiles and registers a services.ts', async () => {
      await write('sessions.mjs', SESSION_SERVICE_SOURCE);
      await write(
        'services.ts',
        `import {Sessions} from './sessions.mjs';

const scheme: string = 'fromts';
export const services = [
  {scheme, type: 'session', create: (uri: string) => new Sessions(uri)},
];
`,
      );

      await loadServicesModule(agentRoot, registry);

      expect(await sessionIdFor('fromts://demo')).toBe('fromts://demo');
    });

    it('keeps running when the module throws while loading', async () => {
      await write('services.js', 'throw new Error("boom");\n');

      await loadServicesModule(agentRoot, registry);

      expect(warnings()).toContain('boom');
    });

    it('keeps running when the module throws something that is not an Error', async () => {
      await write('services.js', 'throw "just a string";\n');

      await loadServicesModule(agentRoot, registry);

      expect(warnings()).toContain('just a string');
    });

    it('reports a module that exports no services list', async () => {
      await write('services.js', 'export const other = 1;\n');

      await loadServicesModule(agentRoot, registry);

      expect(warnings()).toContain('exports no "services" array');
    });

    it('skips a malformed entry and keeps its siblings', async () => {
      await write('sessions.mjs', SESSION_SERVICE_SOURCE);
      await write(
        'services.js',
        `import {Sessions} from './sessions.mjs';
export const services = [
  {scheme: 'nocreate', type: 'session'},
  {scheme: 'ok', type: 'session', create: (uri) => new Sessions(uri)},
];
`,
      );

      await loadServicesModule(agentRoot, registry);

      expect(warnings()).toContain('Invalid service registration');
      expect(await sessionIdFor('ok://demo')).toBe('ok://demo');
    });
  });

  describe('scheme lookup', () => {
    it('returns undefined for a scheme nobody registered', () => {
      expect(registry.createSessionService('unknown://x')).toBeUndefined();
      expect(registry.createArtifactService('unknown://x')).toBeUndefined();
    });

    it('returns undefined for a URI carrying no scheme', () => {
      registry.register({
        scheme: 'demo',
        type: 'session',
        create: () => {
          expect.fail('a URI with no scheme must not reach a factory');
        },
      });

      expect(registry.createSessionService('./relative/path')).toBeUndefined();
    });

    it('reads the scheme of a URI whose body is a relative path', async () => {
      await write('sessions.mjs', SESSION_SERVICE_SOURCE);
      await write(
        'services.yaml',
        `services:
  - scheme: mydb
    type: session
    module: ./sessions.mjs
    export: Sessions
`,
      );

      await loadServicesModule(agentRoot, registry);

      expect(await sessionIdFor('mydb://./local.db')).toBe('mydb://./local.db');
    });
  });
});
