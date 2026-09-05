/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {managedwriter} from '@google-cloud/bigquery-storage';
import {loadOptionalPeer} from '../utils/optional_peer.js';
import type {BigQueryCredentials} from './bigquery_analytics_config.js';

/**
 * The row list `JSONWriter.appendRows` accepts.
 *
 * `@google-cloud/bigquery-storage` declares this type as `JSONList` inside
 * `managedwriter/json_writer` and does not re-export it, so it is read off the
 * method that consumes it rather than imported from a path inside the package.
 */
export type AnalyticsJsonRows = Parameters<
  managedwriter.JSONWriter['appendRows']
>[0];

/**
 * An append the Storage Write API refused, in whole or per row.
 *
 * `code` is the gRPC status of a whole-append refusal, and `rowErrors` names
 * the rows the service singled out. The writer reads both: the status decides
 * whether another attempt is worth making, and the row list decides how many
 * rows to charge as lost.
 */
export class AnalyticsAppendError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly rowErrors: readonly unknown[],
  ) {
    super(message);
    this.name = 'AnalyticsAppendError';
  }
}

/** Everything {@link AnalyticsRowStream} needs to reach one events table. */
export interface AnalyticsRowStreamOptions {
  projectId: string;
  datasetId: string;
  tableId: string;
  credentials?: BigQueryCredentials;
}

/** The `projects/.../datasets/.../tables/...` name the Write API takes. */
function destinationTableName(options: AnalyticsRowStreamOptions): string {
  const {projectId, datasetId, tableId} = options;
  return `projects/${projectId}/datasets/${datasetId}/tables/${tableId}`;
}

/**
 * An open append stream to one events table, over the BigQuery Storage Write
 * API.
 *
 * The client, the stream connection and the JSON writer are created together,
 * used together and torn down together, so they live behind one handle rather
 * than being passed around as three. {@link open} releases whatever it has
 * already acquired if a later step fails, so a half-built stream never leaks a
 * gRPC channel.
 *
 * Rows go to the table's default stream. That stream commits an append as soon
 * as it is acknowledged and needs no offset bookkeeping, which is what suits a
 * telemetry writer that must never block an agent run. It delivers at least
 * once: a retried append that the service had in fact accepted can duplicate
 * rows, and `event_id` is the key to de-duplicate on when reading.
 */
export class AnalyticsRowStream {
  private closed = false;

  private constructor(
    private readonly client: managedwriter.WriterClient,
    private readonly connection: Awaited<
      ReturnType<managedwriter.WriterClient['createStreamConnection']>
    >,
    private readonly writer: managedwriter.JSONWriter,
  ) {}

  /**
   * Opens the append stream, loading the optional peer on the way.
   *
   * The proto descriptor is built from the schema the service reports for the
   * live table, not from the schema this process wanted, so a table another
   * writer already upgraded is appended to correctly.
   *
   * @param options Which table to append to, and how to authenticate.
   * @return An open stream, which the caller must {@link close}.
   */
  static async open(
    options: AnalyticsRowStreamOptions,
  ): Promise<AnalyticsRowStream> {
    const {
      adapt,
      managedwriter: mw,
      protos,
    } = await loadOptionalPeer(
      {
        packageName: '@google-cloud/bigquery-storage',
        feature: 'BigQueryAgentAnalyticsPlugin',
      },
      () => import('@google-cloud/bigquery-storage'),
    );
    const destinationTable = destinationTableName(options);
    const client = new mw.WriterClient({
      projectId: options.projectId,
      credentials: options.credentials,
    });
    try {
      const stream = await client.getWriteStream({
        streamId: `${destinationTable}/streams/_default`,
        // The schema only comes back on the full view.
        view: protos.google.cloud.bigquery.storage.v1.WriteStreamView.FULL,
      });
      const {tableSchema} = stream;
      if (tableSchema === null || tableSchema === undefined) {
        // Fail at the boundary rather than inside the SDK's converter, so the
        // writer's setup handler can report a cause a reader can act on.
        throw new Error(
          `the BigQuery Storage Write API returned no schema for ` +
            `${destinationTable}; the full stream view should carry one`,
        );
      }
      const protoDescriptor = adapt.convertStorageSchemaToProto2Descriptor(
        tableSchema,
        'root',
      );
      const connection = await client.createStreamConnection({
        streamId: mw.DefaultStream,
        destinationTable,
      });
      try {
        const writer = new mw.JSONWriter({connection, protoDescriptor});
        return new AnalyticsRowStream(client, connection, writer);
      } catch (err: unknown) {
        connection.close();
        throw err;
      }
    } catch (err: unknown) {
      client.close();
      throw err;
    }
  }

  /**
   * Appends `rows` and waits for the service to acknowledge them.
   *
   * The service reports a refusal two ways: the append promise rejects, or it
   * resolves carrying a status. Both mean the rows did not land, so the second
   * is raised as an {@link AnalyticsAppendError} rather than read as success.
   *
   * @param rows The rows to append.
   * @throws When the service refuses the append; the caller classifies it.
   */
  async append(rows: AnalyticsJsonRows): Promise<void> {
    const response = await this.writer.appendRows(rows).getResult();
    const {error, rowErrors} = response;
    if (error === null || error === undefined) {
      return;
    }
    throw new AnalyticsAppendError(
      error.message ?? 'the BigQuery Storage Write API refused the append',
      error.code ?? undefined,
      rowErrors ?? [],
    );
  }

  /** Releases the writer, the connection and the client. Safe to call twice. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.writer.close();
    this.connection.close();
    this.client.close();
  }
}
