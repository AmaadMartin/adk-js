/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createPartFromBase64, createPartFromUri, Part} from '@google/genai';
import {cloneDeep} from 'lodash-es';
import {describe, expect, it} from 'vitest';
import {extractMediaParts} from '../../src/utils/media_part_utils.js';

const PNG_DATA = 'aW1hZ2UtYnl0ZXM=';
const JPEG_DATA = 'b3RoZXItaW1hZ2UtYnl0ZXM=';

const pngPart = createPartFromBase64(PNG_DATA, 'image/png');
const jpegPart = createPartFromBase64(JPEG_DATA, 'image/jpeg');
const filePart = createPartFromUri('gs://bucket/chart.png', 'image/png');

const pngResponsePart = {inlineData: {data: PNG_DATA, mimeType: 'image/png'}};
const jpegResponsePart = {
  inlineData: {data: JPEG_DATA, mimeType: 'image/jpeg'},
};

class Report {
  constructor(readonly chart: Part) {}
}

describe('extractMediaParts', () => {
  it('extracts a bare inline-data part and empties the response body', () => {
    const result = extractMediaParts(pngPart);

    expect(result.parts).toEqual([pngResponsePart]);
    expect(result.remainder).toEqual({});
  });

  it('extracts a bare file-reference part', () => {
    const result = extractMediaParts(filePart);

    expect(result.parts).toEqual([
      {fileData: {fileUri: 'gs://bucket/chart.png', mimeType: 'image/png'}},
    ]);
    expect(result.remainder).toEqual({});
  });

  it('keeps a file reference that carries no mime type', () => {
    const value = {fileData: {fileUri: 'gs://bucket/chart.png'}};

    const result = extractMediaParts(value);

    expect(result.parts).toBeUndefined();
    expect(result.remainder).toBe(value);
  });

  it('keeps inline data that carries no bytes', () => {
    const value = {inlineData: {mimeType: 'image/png'}};

    const result = extractMediaParts(value);

    expect(result.parts).toBeUndefined();
    expect(result.remainder).toBe(value);
  });

  it('extracts inline data whose bytes are an empty string', () => {
    const result = extractMediaParts(createPartFromBase64('', 'image/png'));

    expect(result.parts).toEqual([
      {inlineData: {data: '', mimeType: 'image/png'}},
    ]);
    expect(result.remainder).toEqual({});
  });

  it('extracts a part held under a record key and keeps the other keys', () => {
    const result = extractMediaParts({chart: pngPart, summary: 'up 3%'});

    expect(result.parts).toEqual([pngResponsePart]);
    expect(result.remainder).toEqual({summary: 'up 3%'});
  });

  it('extracts array parts in order and keeps the non-media tail', () => {
    const result = extractMediaParts([pngPart, jpegPart, 'two charts']);

    expect(result.parts).toEqual([pngResponsePart, jpegResponsePart]);
    expect(result.remainder).toEqual(['two charts']);
  });

  it('empties the response body for an array of only parts', () => {
    const result = extractMediaParts([pngPart, jpegPart]);

    expect(result.parts).toEqual([pngResponsePart, jpegResponsePart]);
    expect(result.remainder).toEqual({});
  });

  it('empties the response body when the only record key held media', () => {
    const result = extractMediaParts({chart: pngPart});

    expect(result.parts).toEqual([pngResponsePart]);
    expect(result.remainder).toEqual({});
  });

  it('extracts parts nested one container deep and drops the emptied key', () => {
    const result = extractMediaParts({
      images: [pngPart, jpegPart],
      summary: 'two charts',
    });

    expect(result.parts).toEqual([pngResponsePart, jpegResponsePart]);
    expect(result.remainder).toEqual({summary: 'two charts'});
  });

  it('leaves media buried deeper than one container in the response body', () => {
    const value = {report: {charts: {first: pngPart}}};

    const result = extractMediaParts(value);

    expect(result.parts).toBeUndefined();
    expect(result.remainder).toBe(value);
  });

  it('reads a record carrying a part field as a record, not as one part', () => {
    const value = {
      inlineData: {data: PNG_DATA, mimeType: 'image/png'},
      summary: 'up 3%',
    };

    const result = extractMediaParts(value);

    expect(result.parts).toBeUndefined();
    expect(result.remainder).toBe(value);
  });

  it.each([
    ['a plain record', {summary: 'up 3%'}],
    ['a string', 'two charts'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an empty array', []],
    ['an empty record', {}],
  ])('returns %s unchanged when it holds no media', (_name, value) => {
    const result = extractMediaParts(value);

    expect(result.parts).toBeUndefined();
    expect(result.remainder).toBe(value);
  });

  it.each([
    ['a class instance', new Report(pngPart)],
    ['a Date', Object.assign(new Date(0), {chart: pngPart})],
  ])('does not descend into %s', (_name, value) => {
    const result = extractMediaParts({payload: value});

    expect(result.parts).toBeUndefined();
  });

  it('does not mutate the result it is given', () => {
    const value = {images: [pngPart, jpegPart], summary: 'two charts'};
    const before = cloneDeep(value);

    extractMediaParts(value);

    expect(value).toEqual(before);
  });
});
