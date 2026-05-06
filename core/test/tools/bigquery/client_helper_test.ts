/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {BigQuery} from '@google-cloud/bigquery';
import {CatalogServiceClient} from '@google-cloud/dataplex';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {Context} from '../../../src/agents/context.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import * as clientHelper from '../../../src/tools/bigquery/client_helper.js';

vi.mock('@google-cloud/bigquery', () => {
  return {
    BigQuery: vi.fn().mockImplementation((options) => {
      return {options};
    }),
  };
});

vi.mock('@google-cloud/dataplex', () => {
  return {
    CatalogServiceClient: vi.fn().mockImplementation((options) => {
      return {options};
    }),
  };
});

describe('Client Helper', () => {
  let context: Context;

  beforeEach(() => {
    vi.clearAllMocks();
    context = new Context({
      invocationContext: {
        session: {id: 'session-1', state: new Map()},
      } as unknown as InvocationContext,
      functionCallId: 'test-call-id',
    });
  });

  describe('getBigQueryClient', () => {
    it('should create client with default options', async () => {
      const client = await clientHelper.getBigQueryClient('project-1');
      expect(client).toBeDefined();
      expect(BigQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-1',
          userAgent: 'adk-bigquery-tool google-adk-js',
        }),
      );
    });

    it('should include location if configured', async () => {
      await clientHelper.getBigQueryClient('project-1', undefined, {
        location: 'US',
      });
      expect(BigQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          location: 'US',
        }),
      );
    });

    it('should include applicationName in userAgent if configured', async () => {
      await clientHelper.getBigQueryClient('project-1', undefined, {
        applicationName: 'my-app',
      });
      expect(BigQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: 'adk-bigquery-tool google-adk-js my-app',
        }),
      );
    });

    it('should pass credentials if provided', async () => {
      const credentials = {client_email: 'test@test.com', private_key: 'key'};
      await clientHelper.getBigQueryClient('project-1', {credentials});
      expect(BigQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials,
        }),
      );
    });

    it('should use externalAccessTokenKey if provided and token exists', async () => {
      context.state.set('my-token-key', 'secret-token');
      await clientHelper.getBigQueryClient(
        'project-1',
        {externalAccessTokenKey: 'my-token-key'},
        undefined,
        context,
      );
      expect(BigQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'secret-token',
        }),
      );
    });

    it('should throw error if externalAccessTokenKey is provided but token missing', async () => {
      await expect(
        clientHelper.getBigQueryClient(
          'project-1',
          {externalAccessTokenKey: 'my-token-key'},
          undefined,
          context,
        ),
      ).rejects.toThrow(
        'externalAccessTokenKey is provided but no access token found',
      );
    });

    it('should handle OAuth flow if clientId and clientSecret are provided (success)', async () => {
      const getAuthResponseSpy = vi
        .spyOn(context, 'getAuthResponse')
        .mockReturnValue({
          oauth2: {accessToken: 'oauth-token'},
        } as any);

      await clientHelper.getBigQueryClient(
        'project-1',
        {clientId: 'id', clientSecret: 'secret'},
        undefined,
        context,
      );

      expect(BigQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'oauth-token',
        }),
      );
      expect(getAuthResponseSpy).toHaveBeenCalled();
    });

    it('should throw error and request credential if OAuth flow is in progress', async () => {
      vi.spyOn(context, 'getAuthResponse').mockReturnValue(undefined);
      const requestCredentialSpy = vi.spyOn(context, 'requestCredential');

      await expect(
        clientHelper.getBigQueryClient(
          'project-1',
          {clientId: 'id', clientSecret: 'secret'},
          undefined,
          context,
        ),
      ).rejects.toThrow('User authorization is required');

      expect(requestCredentialSpy).toHaveBeenCalled();
    });
  });

  describe('getDataplexClient', () => {
    it('should create client with default options', async () => {
      const client = await clientHelper.getDataplexClient();
      expect(client).toBeDefined();
      expect(CatalogServiceClient).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: 'adk-dataplex-tool google-adk-js',
        }),
      );
    });

    it('should include applicationName in userAgent if configured', async () => {
      await clientHelper.getDataplexClient(undefined, {
        applicationName: 'my-app',
      });
      expect(CatalogServiceClient).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: 'adk-dataplex-tool google-adk-js my-app',
        }),
      );
    });

    it('should pass credentials if provided', async () => {
      const credentials = {client_email: 'test@test.com', private_key: 'key'};
      await clientHelper.getDataplexClient({credentials});
      expect(CatalogServiceClient).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials,
        }),
      );
    });

    it('should use externalAccessTokenKey if provided and token exists', async () => {
      context.state.set('my-token-key', 'secret-token');
      await clientHelper.getDataplexClient(
        {externalAccessTokenKey: 'my-token-key'},
        undefined,
        context,
      );
      expect(CatalogServiceClient).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'secret-token',
        }),
      );
    });

    it('should throw error if externalAccessTokenKey is provided but token missing', async () => {
      await expect(
        clientHelper.getDataplexClient(
          {externalAccessTokenKey: 'my-token-key'},
          undefined,
          context,
        ),
      ).rejects.toThrow(
        'externalAccessTokenKey is provided but no access token found',
      );
    });

    it('should handle OAuth flow if clientId and clientSecret are provided (success)', async () => {
      vi.spyOn(context, 'getAuthResponse').mockReturnValue({
        oauth2: {accessToken: 'oauth-token'},
      } as any);

      await clientHelper.getDataplexClient(
        {clientId: 'id', clientSecret: 'secret'},
        undefined,
        context,
      );

      expect(CatalogServiceClient).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'oauth-token',
        }),
      );
    });

    it('should throw error and request credential if OAuth flow is in progress', async () => {
      vi.spyOn(context, 'getAuthResponse').mockReturnValue(undefined);
      const requestCredentialSpy = vi.spyOn(context, 'requestCredential');

      await expect(
        clientHelper.getDataplexClient(
          {clientId: 'id', clientSecret: 'secret'},
          undefined,
          context,
        ),
      ).rejects.toThrow('User authorization is required');

      expect(requestCredentialSpy).toHaveBeenCalled();
    });
  });
});
