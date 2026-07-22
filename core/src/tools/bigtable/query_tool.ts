/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getBigtableClient} from './client.js';
import {getLogger} from '../../utils/logger.js';
import {z} from 'zod';
import {BigtableToolSettings} from './settings.js';
import {BigtableCredentialsConfig} from './bigtable_credentials.js';

const logger = getLogger();
const DEFAULT_MAX_EXECUTED_QUERY_RESULT_ROWS = 50;

export const ExecuteSqlArgsSchema = z.object({
  projectId: z.string().describe('The GCP project id in which the query should be executed.'),
  instanceId: z.string().describe('The instance id of the Bigtable database.'),
  query: z.string().describe('The Bigtable SQL query to be executed.'),
  parameters: z.record(z.string(), z.any()).optional().describe('properties for parameter replacement. Keys must match the names used in query.'),
  parameterTypes: z.record(z.string(), z.any()).optional().describe('maps explicit types for one or more param values.'),
  _viewParameters: z.record(z.string(), z.any()).optional().describe('maps properties for parameterized views.'),

});

export async function executeSql(
  projectId: string,
  instanceId: string,
  query: string,
  config?: BigtableCredentialsConfig,
  settings?: BigtableToolSettings,
  parameters?: Record<string, any>,
  parameterTypes?: Record<string, any>,
  _viewParameters?: Record<string, any>
): Promise<Record<string, any>> {
  try {
    const client = getBigtableClient(projectId, config);
    const instance = client.instance(instanceId);
    
    // Create the executeQuery stream
    // Using any for the options parameter to bypass missing typescript definitions depending on the sdk version.
    const queryOptions: any = {
      query,
      params: parameters,
    };
    if (parameterTypes) queryOptions.parameterTypes = parameterTypes;
    if (_viewParameters) queryOptions.viewParameters = _viewParameters;

    const stream = instance.createExecuteQueryStream(queryOptions);

    const rows: Record<string, any>[] = [];
    const maxRows = (settings?.maxQueryResultRows && settings.maxQueryResultRows > 0) 
        ? settings.maxQueryResultRows 
        : DEFAULT_MAX_EXECUTED_QUERY_RESULT_ROWS;

    let counter = maxRows;
    let truncated = false;
    
    for await (const row of stream) {
      if (counter <= 0) {
        truncated = true;
        break;
      }
      
      const rowValues: Record<string, any> = {};
      const entries = (row instanceof Map) ? Array.from(row.entries()) : Object.entries(row);
      for (const [key, val] of entries) {
         let safeVal = val;
         try {
            JSON.stringify(val);
         } catch {
            safeVal = String(val);
         }
         rowValues[key as string] = safeVal;
      }
      rows.push(rowValues);
      counter--;
    }
    
    const result: Record<string, any> = { status: 'SUCCESS', rows };
    if (truncated) {
      result.result_is_likely_truncated = true;
    }
    return result;

  } catch (ex: any) {
    logger.error(`Bigtable query failed: ${ex}`);
    return {
      status: 'ERROR',
      error_details: String(ex),
    };
  }
}
