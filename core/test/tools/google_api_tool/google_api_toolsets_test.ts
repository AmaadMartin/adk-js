/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  BigQueryToolset,
  CalendarToolset,
  DocsToolset,
  GmailToolset,
  GoogleApiToolset,
  GoogleApiToolsetPresetOptions,
  isBaseToolset,
  RestApiTool,
  ServiceAccount,
  SheetsToolset,
  SlidesToolset,
  YoutubeToolset,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {CALENDAR_DISCOVERY_DOCUMENT} from './discovery_fixtures.js';
import {capturedRequest, respondWith} from './https_transport_fake.js';

const {requestMock} = vi.hoisted(() => ({requestMock: vi.fn()}));
vi.mock('node:https', () => ({request: requestMock, Agent: vi.fn()}));

/** One prebuilt toolset and the api id pair it pins. */
interface PrebuiltToolset {
  name: string;
  Toolset: new (options?: GoogleApiToolsetPresetOptions) => GoogleApiToolset;
  apiName: string;
  apiVersion: string;
}

const PREBUILT_TOOLSETS: PrebuiltToolset[] = [
  {
    name: 'BigQueryToolset',
    Toolset: BigQueryToolset,
    apiName: 'bigquery',
    apiVersion: 'v2',
  },
  {
    name: 'CalendarToolset',
    Toolset: CalendarToolset,
    apiName: 'calendar',
    apiVersion: 'v3',
  },
  {
    name: 'GmailToolset',
    Toolset: GmailToolset,
    apiName: 'gmail',
    apiVersion: 'v1',
  },
  {
    name: 'YoutubeToolset',
    Toolset: YoutubeToolset,
    apiName: 'youtube',
    apiVersion: 'v3',
  },
  {
    name: 'SlidesToolset',
    Toolset: SlidesToolset,
    apiName: 'slides',
    apiVersion: 'v1',
  },
  {
    name: 'SheetsToolset',
    Toolset: SheetsToolset,
    apiName: 'sheets',
    apiVersion: 'v4',
  },
  {
    name: 'DocsToolset',
    Toolset: DocsToolset,
    apiName: 'docs',
    apiVersion: 'v1',
  },
];

const SERVICE_ACCOUNT: ServiceAccount = {useDefaultCredential: true};

describe('the prebuilt Google API toolsets', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    requestMock.mockReset();
    // The calendar document describes every toolset here: the subclasses only
    // pick which document is fetched, and this test asserts on that choice.
    respondWith(requestMock, {
      statusCode: 200,
      body: JSON.stringify(CALENDAR_DISCOVERY_DOCUMENT),
    });
  });

  it.each(PREBUILT_TOOLSETS)(
    '$name pins its api id pair and is a toolset',
    ({Toolset, apiName, apiVersion}) => {
      const toolset = new Toolset();

      expect(toolset.apiName).toBe(apiName);
      expect(toolset.apiVersion).toBe(apiVersion);
      expect(isBaseToolset(toolset)).toBe(true);
    },
  );

  it.each(PREBUILT_TOOLSETS)(
    '$name fetches the discovery document of its own api',
    async ({Toolset, apiName, apiVersion}) => {
      await new Toolset().getTools();

      expect(capturedRequest(requestMock).url).toBe(
        `https://www.googleapis.com/discovery/v1/apis/${apiName}/${apiVersion}/rest`,
      );
    },
  );

  it('forwards the tool filter and the name prefix to the base class', async () => {
    const toolset = new CalendarToolset({
      toolFilter: ['gcal_calendar.events.list'],
      toolNamePrefix: 'gcal',
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'gcal_calendar.events.list',
    ]);
  });

  it('forwards the client id pair to the base class', async () => {
    const configureAuthCredential = vi.spyOn(
      RestApiTool.prototype,
      'configureAuthCredential',
    );

    await new GmailToolset({
      clientId: 'client-id',
      clientSecret: 'client-secret',
    }).getTools();

    expect(configureAuthCredential).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.OPEN_ID_CONNECT,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    });
  });

  it('forwards the service account to the base class', async () => {
    const configureAuthCredential = vi.spyOn(
      RestApiTool.prototype,
      'configureAuthCredential',
    );

    await new SheetsToolset({serviceAccount: SERVICE_ACCOUNT}).getTools();

    expect(configureAuthCredential).toHaveBeenCalledWith({
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: SERVICE_ACCOUNT,
    });
  });

  it('keeps its pinned api id pair whatever else the caller passes', () => {
    const toolset = new DocsToolset({
      toolNamePrefix: 'docs',
      additionalScopes: ['https://www.googleapis.com/auth/drive'],
      discoveryUrl: 'https://discovery.example/{api}/{apiVersion}.json',
    });

    expect(toolset.apiName).toBe('docs');
    expect(toolset.apiVersion).toBe('v1');
  });
});
