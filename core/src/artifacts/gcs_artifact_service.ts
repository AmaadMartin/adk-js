/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Bucket,
  File,
  FileMetadata,
  GetSignedUrlConfig,
  StorageOptions,
} from '@google-cloud/storage';
import {createPartFromBase64, createPartFromText, Part} from '@google/genai';
import {
  InputValidationError,
  isInputValidationError,
} from '../errors/input_validation_error.js';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {
  ensurePart,
  parseArtifactUri,
  ParsedArtifactUri,
  validateArtifactReferenceScope,
  validatePathSegment,
} from './artifact_util.js';
import {
  ArtifactVersion,
  BaseArtifactService,
  DeleteArtifactRequest,
  ListArtifactKeysRequest,
  ListVersionsRequest,
  LoadArtifactRequest,
  SaveArtifactRequest,
} from './base_artifact_service.js';

const GCS_FILE_URI_METADATA_KEY = 'adkFileUri';
const GCS_FILE_MIME_TYPE_METADATA_KEY = 'adkFileMimeType';
const GCS_DISPLAY_NAME_METADATA_KEY = 'adkDisplayName';
const GCS_IS_TEXT_METADATA_KEY = 'adkIsText';
/** The metadata key artifacts saved before the `adk` prefix existed carry. */
const LEGACY_FILE_URI_METADATA_KEY = 'file_uri';
const USER_NAMESPACE_PREFIX = 'user:';
const ARTIFACT_URI_SCHEME = 'artifact://';
const AUTHENTICATED_URL_HOST = 'https://storage.cloud.google.com';
const DEFAULT_SIGNED_URL_TTL_MS = 60 * 60 * 1000;
/** The longest chain of references a read follows before it is rejected. */
const MAX_ARTIFACT_REFERENCE_DEPTH = 5;
const NOT_FOUND_STATUS = 404;
const VERSION_PATTERN = /^[0-9]+$/;

/**
 * Identifies one artifact. The session is optional because a `user:` filename
 * is user-scoped, and because a reference may name a user-scoped artifact.
 */
interface ArtifactKey {
  appName: string;
  userId: string;
  sessionId?: string;
  filename: string;
}

/** An {@link ArtifactKey} with an optional version, defaulting to the latest. */
interface VersionedArtifactKey extends ArtifactKey {
  version?: number;
}

/** One version of an artifact, as it is stored in the bucket. */
interface StoredObject {
  version: number;
  file: File;
  objectName: string;
  metadata: FileMetadata;
}

/** What an artifact resolves to once its references are followed. */
type ResolvedArtifact =
  | ({kind: 'object'} & StoredObject)
  | {kind: 'reference'; fileUri: string; mimeType?: string};

/** The parameters for {@link GcsArtifactService.getSignedUrl}. */
export interface GetSignedUrlRequest extends LoadArtifactRequest {
  /**
   * Options for the storage client, merged over the defaults: a `'read'`
   * action and an expiry one hour out.
   */
  signingOptions?: Partial<GetSignedUrlConfig>;
}

export class GcsArtifactService implements BaseArtifactService {
  private readonly bucketName: string;
  private readonly storageOptions?: StorageOptions;
  private bucketPromise?: Promise<Bucket>;

  constructor(bucket: string, options?: StorageOptions) {
    this.bucketName = bucket;
    this.storageOptions = options;
  }

  /**
   * Resolves the GCS bucket handle, loading the `@google-cloud/storage`
   * optional peer on first use.
   */
  private getBucket(): Promise<Bucket> {
    this.bucketPromise ??= loadOptionalPeer(
      {packageName: '@google-cloud/storage', feature: 'GcsArtifactService'},
      () => import('@google-cloud/storage'),
    ).then(({Storage}) =>
      new Storage(this.storageOptions).bucket(this.bucketName),
    );
    return this.bucketPromise;
  }

  async saveArtifact(request: SaveArtifactRequest): Promise<number> {
    const artifact = ensurePart(request.artifact);
    if (!artifact.inlineData && !artifact.text && !artifact.fileData) {
      throw new Error('Artifact must have either inlineData or text content.');
    }

    const versions = await this.listVersions(request);
    const version = versions.length > 0 ? Math.max(...versions) + 1 : 0;
    const bucket = await this.getBucket();
    const file = bucket.file(getBlobName(request, version));

    const customMetadata: Record<string, unknown> = {
      ...request.customMetadata,
    };

    if (artifact.inlineData) {
      if (artifact.inlineData.displayName) {
        customMetadata[GCS_DISPLAY_NAME_METADATA_KEY] =
          artifact.inlineData.displayName;
      }
      await file.save(Buffer.from(artifact.inlineData.data || '', 'base64'), {
        contentType: artifact.inlineData.mimeType,
        metadata: {metadata: customMetadata},
      });

      return version;
    } else if (artifact.text !== undefined) {
      await file.save(artifact.text, {
        contentType: 'text/plain',
        metadata: {
          metadata: {...customMetadata, [GCS_IS_TEXT_METADATA_KEY]: 'true'},
        },
      });

      return version;
    } else {
      const fileData = artifact.fileData;
      const fileUri = fileData?.fileUri;
      if (!fileUri) {
        throw new InputValidationError(
          'Artifact fileData must have a fileUri.',
        );
      }
      if (fileUri.startsWith(ARTIFACT_URI_SCHEME)) {
        validateArtifactReferenceScope(request, parseReference(fileUri));
      }
      // Store the URI and mime_type (if any) as blob metadata; no content to upload.
      customMetadata[GCS_FILE_URI_METADATA_KEY] = fileUri;
      if (fileData.mimeType) {
        customMetadata[GCS_FILE_MIME_TYPE_METADATA_KEY] = fileData.mimeType;
      }
      await file.save('', {
        contentType: fileData.mimeType || undefined,
        metadata: {metadata: customMetadata},
      });
      return version;
    }
  }

  async loadArtifact(request: LoadArtifactRequest): Promise<Part | undefined> {
    try {
      const resolved = await this.resolveArtifact(request);
      if (resolved === undefined) {
        return undefined;
      }
      if (resolved.kind === 'reference') {
        return {
          fileData: {fileUri: resolved.fileUri, mimeType: resolved.mimeType},
        };
      }
      return await downloadPart(resolved);
    } catch (e: unknown) {
      if (isInputValidationError(e)) {
        throw e;
      }
      logger.warn(
        `[GcsArtifactService] loadArtifact: Failed to load artifact ${request.filename}`,
        e,
      );
      return undefined;
    }
  }

  async listArtifactKeys(request: ListArtifactKeysRequest): Promise<string[]> {
    validatePathSegment(request.appName, 'appName');
    validatePathSegment(request.userId, 'userId');
    validatePathSegment(request.sessionId, 'sessionId');

    const sessionPrefix = `${request.appName}/${request.userId}/${request.sessionId}/`;
    const usernamePrefix = `${request.appName}/${request.userId}/user/`;
    const bucket = await this.getBucket();
    const [[sessionFiles], [userSessionFiles]] = await Promise.all([
      bucket.getFiles({prefix: sessionPrefix}),
      bucket.getFiles({prefix: usernamePrefix}),
    ]);

    return [
      ...extractArtifactKeys(sessionFiles, sessionPrefix),
      ...extractArtifactKeys(
        userSessionFiles,
        usernamePrefix,
        USER_NAMESPACE_PREFIX,
      ),
    ].sort((a, b) => a.localeCompare(b));
  }

  async deleteArtifact(request: DeleteArtifactRequest): Promise<void> {
    const versions = await this.listVersions(request);
    const bucket = await this.getBucket();

    await Promise.all(
      versions.map((version) =>
        bucket.file(getBlobName(request, version)).delete(),
      ),
    );

    return;
  }

  async listVersions(request: ListVersionsRequest): Promise<number[]> {
    return this.listVersionsOf(request);
  }

  async listArtifactVersions(
    request: ListVersionsRequest,
  ): Promise<ArtifactVersion[]> {
    const versions = await this.listVersions(request);
    const artifactVersions: ArtifactVersion[] = [];

    for (const version of versions) {
      const artifactVersion = await this.getArtifactVersion({
        ...request,
        version,
      });

      if (artifactVersion) {
        artifactVersions.push(artifactVersion);
      }
    }

    return artifactVersions;
  }

  async getArtifactVersion(
    request: LoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined> {
    try {
      const stored = await this.readObject(request);
      if (stored === undefined) {
        return undefined;
      }

      return {
        version: stored.version,
        mimeType: stored.metadata.contentType,
        customMetadata: stored.metadata.metadata,
        canonicalUri: `gs://${this.bucketName}/${stored.objectName}`,
        createTime: toEpochSeconds(stored.metadata.timeCreated),
      };
    } catch (e: unknown) {
      if (isInputValidationError(e)) {
        throw e;
      }
      logger.warn(
        `[GcsArtifactService] getArtifactVersion: Failed to get artifact version for userId: ${request.userId} sessionId: ${request.sessionId} filename: ${request.filename} version: ${request.version}`,
        e,
      );
      return undefined;
    }
  }

  /**
   * Generates a browser URL for an artifact.
   *
   * The reader must be signed in to a Google account that holds read
   * permission on the object; the URL carries no credential of its own.
   *
   * @param request The artifact to address; the latest version when the
   *     request names none.
   * @return The `https://storage.cloud.google.com/...` URL, or undefined when
   *     the artifact does not exist, or holds a pointer to a file this service
   *     does not own.
   */
  async getAuthenticatedUrl(
    request: LoadArtifactRequest,
  ): Promise<string | undefined> {
    const resolved = await this.resolveArtifact(request);
    if (resolved?.kind !== 'object') {
      return undefined;
    }
    return `${AUTHENTICATED_URL_HOST}/${this.bucketName}/${encodeObjectName(resolved.objectName)}`;
  }

  /**
   * Generates a time-limited signed URL for an artifact.
   *
   * The URL authorizes itself, so its reader needs no Google account.
   * `signingOptions` carries what adk-python's `get_signed_url` takes as
   * keyword arguments: `expires` for `expiration`, `action` for `method`,
   * `version` for `signing_version`, and any further field the storage
   * client's own config accepts.
   *
   * @param request The artifact to address, plus the signing options.
   * @return The signed URL, or undefined when the artifact does not exist, or
   *     holds a pointer to a file this service does not own.
   */
  async getSignedUrl(
    request: GetSignedUrlRequest,
  ): Promise<string | undefined> {
    const resolved = await this.resolveArtifact(request);
    if (resolved?.kind !== 'object') {
      return undefined;
    }
    const [url] = await resolved.file.getSignedUrl({
      action: 'read',
      expires: Date.now() + DEFAULT_SIGNED_URL_TTL_MS,
      ...request.signingOptions,
    });
    return url;
  }

  private async listVersionsOf(key: ArtifactKey): Promise<number[]> {
    // The trailing slash keeps the scan to the children of this artifact.
    const searchPrefix = `${getBlobPrefix(key)}/`;
    const bucket = await this.getBucket();
    const [files] = await bucket.getFiles({prefix: searchPrefix});
    const versions: number[] = [];
    for (const file of files) {
      const version = parseVersion(file.name, searchPrefix);
      if (version !== undefined) {
        versions.push(version);
      }
    }

    return versions.sort((a, b) => a - b);
  }

  /** Reads the object holding one version, without following references. */
  private async readObject(
    key: VersionedArtifactKey,
  ): Promise<StoredObject | undefined> {
    const versions =
      key.version === undefined
        ? await this.listVersionsOf(key)
        : [key.version];
    if (versions.length === 0) {
      return undefined;
    }
    const version = Math.max(...versions);

    const objectName = getBlobName(key, version);
    const file = (await this.getBucket()).file(objectName);
    const metadata = await getMetadataIfExists(file);
    if (metadata === undefined) {
      return undefined;
    }

    return {version, file, objectName, metadata};
  }

  /**
   * Reads an artifact, following any chain of `artifact://` references.
   *
   * @param key The artifact to read; the latest version when the key names
   *     none.
   * @param depth How many further references the chain may hold.
   * @return The stored object, the external pointer it holds, or undefined
   *     when the artifact does not exist.
   * @throws InputValidationError When a reference leaves the caller's scope,
   *     does not parse, or the chain is longer than `depth` hops.
   */
  private async resolveArtifact(
    key: VersionedArtifactKey,
    depth = MAX_ARTIFACT_REFERENCE_DEPTH,
  ): Promise<ResolvedArtifact | undefined> {
    const stored = await this.readObject(key);
    if (stored === undefined) {
      return undefined;
    }

    const fileUri = readFileUri(stored.metadata);
    if (fileUri === undefined) {
      return {kind: 'object', ...stored};
    }
    if (!fileUri.startsWith(ARTIFACT_URI_SCHEME)) {
      return {
        kind: 'reference',
        fileUri,
        mimeType:
          readMetadataString(
            stored.metadata,
            GCS_FILE_MIME_TYPE_METADATA_KEY,
          ) ?? stored.metadata.contentType,
      };
    }
    if (depth <= 0) {
      throw new InputValidationError(
        `Exceeded maximum recursion depth resolving artifact reference: ${fileUri}`,
      );
    }

    const parsedUri = parseReference(fileUri);
    validateArtifactReferenceScope(key, parsedUri);
    return this.resolveArtifact(parsedUri, depth - 1);
  }
}

/** Parses a stored `artifact://` URI, rejecting one that does not conform. */
function parseReference(fileUri: string): ParsedArtifactUri {
  const parsedUri = parseArtifactUri(fileUri);
  if (!parsedUri) {
    throw new InputValidationError(
      `Invalid artifact reference URI: ${fileUri}`,
    );
  }
  return parsedUri;
}

/**
 * Builds the object-name prefix an artifact's versions live under.
 *
 * @throws InputValidationError When an identifier would alter the path, or a
 *     session-scoped artifact is addressed with no session.
 */
function getBlobPrefix({
  appName,
  userId,
  sessionId,
  filename,
}: ArtifactKey): string {
  validatePathSegment(appName, 'appName');
  validatePathSegment(userId, 'userId');

  if (filename.startsWith(USER_NAMESPACE_PREFIX)) {
    const cleanFilename = filename.slice(USER_NAMESPACE_PREFIX.length);
    return `${appName}/${userId}/user/${cleanFilename}`;
  }

  if (sessionId === undefined) {
    throw new InputValidationError(
      'Session ID must be provided for session-scoped artifacts.',
    );
  }
  validatePathSegment(sessionId, 'sessionId');
  return `${appName}/${userId}/${sessionId}/${filename}`;
}

function getBlobName(key: ArtifactKey, version: number): string {
  return `${getBlobPrefix(key)}/${version}`;
}

/**
 * Extracts the version an object holds, or undefined when it holds none.
 *
 * GCS has a flat namespace and a filename may contain `/`, so an artifact's
 * prefix is also the prefix of every artifact nested under it: scanning `a/`
 * for versions of `a` also returns `a/b/3`, which is version 3 of the distinct
 * artifact `a/b`.
 *
 * @param objectName The full object name, which starts with `prefix`.
 * @param prefix The artifact's object-name prefix, including the trailing `/`.
 */
function parseVersion(objectName: string, prefix: string): number | undefined {
  const suffix = objectName.slice(prefix.length);
  if (!VERSION_PATTERN.test(suffix)) {
    return undefined;
  }
  return Number(suffix);
}

/** Reads an object's metadata, reporting a 404 as an absent artifact. */
async function getMetadataIfExists(
  file: File,
): Promise<FileMetadata | undefined> {
  try {
    const [metadata] = await file.getMetadata();
    return metadata;
  } catch (e: unknown) {
    if (
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      e.code === NOT_FOUND_STATUS
    ) {
      return undefined;
    }
    throw e;
  }
}

function readMetadataString(
  metadata: FileMetadata,
  key: string,
): string | undefined {
  const value = metadata.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readFileUri(metadata: FileMetadata): string | undefined {
  return (
    readMetadataString(metadata, GCS_FILE_URI_METADATA_KEY) ??
    readMetadataString(metadata, LEGACY_FILE_URI_METADATA_KEY)
  );
}

async function downloadPart(stored: StoredObject): Promise<Part> {
  const [rawDataBuffer] = await stored.file.download();

  const displayName = readMetadataString(
    stored.metadata,
    GCS_DISPLAY_NAME_METADATA_KEY,
  );
  if (displayName) {
    return {
      inlineData: {
        data: rawDataBuffer.toString('base64'),
        mimeType: stored.metadata.contentType,
        displayName,
      },
    };
  }

  if (
    readMetadataString(stored.metadata, GCS_IS_TEXT_METADATA_KEY) === 'true' ||
    stored.metadata.contentType === 'text/plain'
  ) {
    return createPartFromText(rawDataBuffer.toString('utf-8'));
  }

  return createPartFromBase64(
    rawDataBuffer.toString('base64'),
    stored.metadata.contentType!,
  );
}

/** Percent-encodes an object name for a URL, keeping the `/` separators. */
function encodeObjectName(objectName: string): string {
  return objectName
    .split('/')
    .map((segment) =>
      // encodeURIComponent keeps `!'()*` where a GCS object path escapes them.
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

function toEpochSeconds(timeCreated?: string): number | undefined {
  if (timeCreated === undefined) {
    return undefined;
  }
  const parsed = Date.parse(timeCreated);
  return Number.isNaN(parsed) ? undefined : parsed / 1000;
}

function extractArtifactKeys(
  files: File[],
  fileNamePrefix: string,
  keyPrefix: string = '',
): string[] {
  const keys = new Set<string>();
  for (const file of files) {
    if (!file.name.startsWith(fileNamePrefix)) {
      continue;
    }

    const relative = file.name.substring(fileNamePrefix.length);
    const name = getFileNameFromPath(relative);

    keys.add(`${keyPrefix}${name}`);
  }

  return [...keys];
}

function getFileNameFromPath(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length < 2) {
    return filePath;
  }

  return parts.slice(0, -1).join('/');
}
