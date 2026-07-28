/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A self-contained implementation of the classic Porter stemming algorithm
 * (M.F. Porter, 1980).
 *
 * The ROUGE default tokenizer that adk-python depends on strips word suffixes
 * with a Porter stemmer to improve unigram matching. No JS ROUGE/stemmer
 * dependency exists, so the algorithm is reimplemented here to preserve
 * behavioral parity with the reference implementation (e.g. `running` -> `run`,
 * `jumped` -> `jump`, `candidate` -> `candid`, `reference` -> `refer`).
 *
 * simplicity: This is the smallest faithful port that reproduces the reference
 * stem outputs; upgrade path is to depend on a vetted ROUGE package if one ever
 * becomes available with matching semantics.
 */

const STEP2_SUFFIXES: Record<string, string> = {
  ational: 'ate',
  tional: 'tion',
  enci: 'ence',
  anci: 'ance',
  izer: 'ize',
  bli: 'ble',
  alli: 'al',
  entli: 'ent',
  eli: 'e',
  ousli: 'ous',
  ization: 'ize',
  ation: 'ate',
  ator: 'ate',
  alism: 'al',
  iveness: 'ive',
  fulness: 'ful',
  ousness: 'ous',
  aliti: 'al',
  iviti: 'ive',
  biliti: 'ble',
  logi: 'log',
};

const STEP3_SUFFIXES: Record<string, string> = {
  icate: 'ic',
  ative: '',
  alize: 'al',
  iciti: 'ic',
  ical: 'ic',
  ful: '',
  ness: '',
};

// Regex fragments describing consonant/vowel sequences, as in the reference
// algorithm. `c`/`v` match a single consonant/vowel; `C`/`V` match runs.
const CONSONANT = '[^aeiou]';
const VOWEL = '[aeiouy]';
const CONSONANT_SEQ = CONSONANT + '[^aeiouy]*';
const VOWEL_SEQ = VOWEL + '[aeiou]*';

// measure > 0 : stem contains at least one VC sequence.
const MGR0 = new RegExp(
  '^(' + CONSONANT_SEQ + ')?' + VOWEL_SEQ + CONSONANT_SEQ,
);
// measure == 1 : stem is exactly one VC (optionally followed by a vowel).
const MEQ1 = new RegExp(
  '^(' +
    CONSONANT_SEQ +
    ')?' +
    VOWEL_SEQ +
    CONSONANT_SEQ +
    '(' +
    VOWEL_SEQ +
    ')?$',
);
// measure > 1 : stem contains at least two VC sequences.
const MGR1 = new RegExp(
  '^(' +
    CONSONANT_SEQ +
    ')?' +
    VOWEL_SEQ +
    CONSONANT_SEQ +
    VOWEL_SEQ +
    CONSONANT_SEQ,
);
// stem contains a vowel.
const CONTAINS_VOWEL = new RegExp('^(' + CONSONANT_SEQ + ')?' + VOWEL);
// stem ends in cvc where the final consonant is not w, x, or y.
const CVC = new RegExp('^' + CONSONANT_SEQ + VOWEL + '[^aeiouwxy]$');

/**
 * Returns the Porter stem of a single word.
 *
 * @param word A lowercase word to stem.
 */
export function porterStem(word: string): string {
  if (word.length < 3) {
    return word;
  }

  let w = word;
  const firstChar = w.charAt(0);
  // Treat a leading 'y' as a consonant for the duration of stemming.
  if (firstChar === 'y') {
    w = 'Y' + w.substring(1);
  }

  // Step 1a
  let re = /^(.+?)(ss|i)es$/;
  let re2 = /^(.+?)([^s])s$/;
  if (re.test(w)) {
    w = w.replace(re, '$1$2');
  } else if (re2.test(w)) {
    w = w.replace(re2, '$1$2');
  }

  // Step 1b
  re = /^(.+?)eed$/;
  re2 = /^(.+?)(ed|ing)$/;
  if (re.test(w)) {
    const fp = re.exec(w)!;
    if (MGR0.test(fp[1])) {
      w = w.replace(/.$/, '');
    }
  } else if (re2.test(w)) {
    const fp = re2.exec(w)!;
    const stem = fp[1];
    if (CONTAINS_VOWEL.test(stem)) {
      w = stem;
      if (/(at|bl|iz)$/.test(w)) {
        w = w + 'e';
      } else if (/([^aeiouylsz])\1$/.test(w)) {
        w = w.replace(/.$/, '');
      } else if (CVC.test(w)) {
        w = w + 'e';
      }
    }
  }

  // Step 1c
  re = /^(.+?)y$/;
  if (re.test(w)) {
    const stem = re.exec(w)![1];
    if (CONTAINS_VOWEL.test(stem)) {
      w = stem + 'i';
    }
  }

  // Step 2
  re =
    /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
  if (re.test(w)) {
    const fp = re.exec(w)!;
    if (MGR0.test(fp[1])) {
      w = fp[1] + STEP2_SUFFIXES[fp[2]];
    }
  }

  // Step 3
  re = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
  if (re.test(w)) {
    const fp = re.exec(w)!;
    if (MGR0.test(fp[1])) {
      w = fp[1] + STEP3_SUFFIXES[fp[2]];
    }
  }

  // Step 4
  re =
    /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
  re2 = /^(.+?)(s|t)(ion)$/;
  if (re.test(w)) {
    const fp = re.exec(w)!;
    if (MGR1.test(fp[1])) {
      w = fp[1];
    }
  } else if (re2.test(w)) {
    const fp = re2.exec(w)!;
    const stem = fp[1] + fp[2];
    if (MGR1.test(stem)) {
      w = stem;
    }
  }

  // Step 5
  re = /^(.+?)e$/;
  if (re.test(w)) {
    const stem = re.exec(w)![1];
    if (MGR1.test(stem) || (MEQ1.test(stem) && !CVC.test(stem))) {
      w = stem;
    }
  }
  if (/ll$/.test(w) && MGR1.test(w)) {
    w = w.replace(/.$/, '');
  }

  // Restore an initial 'y' that was upper-cased for consonant handling.
  if (firstChar === 'y') {
    w = 'y' + w.substring(1);
  }

  return w;
}
