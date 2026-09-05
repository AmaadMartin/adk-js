/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {createProgram} from '../../src/cli/cli.js';
import {AdkApiServer, ServerOptions} from '../../src/server/adk_api_server.js';

vi.mock('../../src/server/adk_api_server', () => ({
  AdkApiServer: vi.fn(() => ({start: vi.fn()})),
}));

vi.mock('@google/adk', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  setLogLevel: vi.fn(),
}));

const LOGO_IMAGE_URL = 'https://acme.example/logo.svg';

describe('CLI configuration surface', () => {
  let program: ReturnType<typeof createProgram>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = createProgram();
    program.exitOverride();
  });

  /** Parses `args` and returns the options the server was constructed with. */
  async function serverOptionsFor(args: string[]): Promise<ServerOptions> {
    await program.parseAsync(['node', 'cli_entrypoint.js', ...args]);
    return (AdkApiServer as unknown as Mock).mock.calls[0][0] as ServerOptions;
  }

  for (const command of ['web', 'api_server']) {
    describe(`command: ${command}`, () => {
      it('passes the logo options through', async () => {
        const options = await serverOptionsFor([
          command,
          '--logo_text',
          'Acme',
          '--logo_image_url',
          LOGO_IMAGE_URL,
        ]);

        expect(options.logoText).toBe('Acme');
        expect(options.logoImageUrl).toBe(LOGO_IMAGE_URL);
      });

      it('passes the url prefix through', async () => {
        const options = await serverOptionsFor([
          command,
          '--url_prefix',
          '/adk',
        ]);

        expect(options.urlPrefix).toBe('/adk');
      });

      it('collects a repeated --extra_plugins flag', async () => {
        const options = await serverOptionsFor([
          command,
          '--extra_plugins',
          './a.First',
          '--extra_plugins',
          './b.Second',
        ]);

        expect(options.extraPlugins).toEqual(['./a.First', './b.Second']);
      });

      it('collects several names given to one --extra_plugins flag', async () => {
        const options = await serverOptionsFor([
          command,
          '--extra_plugins',
          './a.First',
          './b.Second',
        ]);

        expect(options.extraPlugins).toEqual(['./a.First', './b.Second']);
      });

      it('leaves the new options unset when no flag is given', async () => {
        const options = await serverOptionsFor([command]);

        expect(options.logoText).toBeUndefined();
        expect(options.logoImageUrl).toBeUndefined();
        expect(options.urlPrefix).toBeUndefined();
        expect(options.extraPlugins).toBeUndefined();
      });
    });
  }
});
