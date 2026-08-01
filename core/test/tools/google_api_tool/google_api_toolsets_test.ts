/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BigQueryToolset,
  CalendarToolset,
  DocsToolset,
  GmailToolset,
  GoogleApiToolset,
  GoogleApiToolsetPresetOptions,
  SheetsToolset,
  SlidesToolset,
  YoutubeToolset,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CALENDAR_DISCOVERY_DOCUMENT} from './discovery_fixtures.js';

interface PresetCase {
  name: string;
  create: (options?: GoogleApiToolsetPresetOptions) => GoogleApiToolset;
  api: string;
  version: string;
}

const PRESETS: PresetCase[] = [
  {
    name: 'BigQueryToolset',
    create: (options) => new BigQueryToolset(options),
    api: 'bigquery',
    version: 'v2',
  },
  {
    name: 'CalendarToolset',
    create: (options) => new CalendarToolset(options),
    api: 'calendar',
    version: 'v3',
  },
  {
    name: 'GmailToolset',
    create: (options) => new GmailToolset(options),
    api: 'gmail',
    version: 'v1',
  },
  {
    name: 'YoutubeToolset',
    create: (options) => new YoutubeToolset(options),
    api: 'youtube',
    version: 'v3',
  },
  {
    name: 'SlidesToolset',
    create: (options) => new SlidesToolset(options),
    api: 'slides',
    version: 'v1',
  },
  {
    name: 'SheetsToolset',
    create: (options) => new SheetsToolset(options),
    api: 'sheets',
    version: 'v4',
  },
  {
    name: 'DocsToolset',
    create: (options) => new DocsToolset(options),
    api: 'docs',
    version: 'v1',
  },
];

describe('pre-built Google API toolsets', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => CALENDAR_DISCOVERY_DOCUMENT,
    });
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(PRESETS)('$name is a GoogleApiToolset', ({create}) => {
    expect(create()).toBeInstanceOf(GoogleApiToolset);
  });

  it.each(PRESETS)(
    '$name discovers $api $version',
    async ({create, api, version}) => {
      await create().getTools();

      expect(fetchMock).toHaveBeenCalledWith(
        `https://www.googleapis.com/discovery/v1/apis/${api}/${version}/rest`,
        expect.anything(),
      );
    },
  );

  it.each(PRESETS)('$name forwards its options', async ({create}) => {
    const toolset = create({
      toolFilter: ['pre_calendar.events.list'],
      prefix: 'pre',
      discoveryUrl: 'https://private.example.com/{api}/{apiVersion}',
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'pre_calendar.events.list',
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://private.example.com/'),
      expect.anything(),
    );
  });
});
