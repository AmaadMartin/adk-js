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

const STEP1A_ES = /^(.+?)(ss|i)es$/;
const STEP1A_S = /^(.+?)([^s])s$/;
const STEP1B_EED = /^(.+?)eed$/;
const STEP1B_ED_ING = /^(.+?)(ed|ing)$/;
const STEP1B_DOUBLE_CONSONANT = /([^aeiouylsz])\1$/;
const STEP1B_CVC_EXTENSION = /(at|bl|iz)$/;
const STEP1C_Y = /^(.+?)y$/;
const STEP2 =
  /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
const STEP3 = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
const STEP4 =
  /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
const STEP4_ION = /^(.+?)(s|t)(ion)$/;
const STEP5_E = /^(.+?)e$/;
const LAST_CHAR = /.$/;

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
  if (STEP1A_ES.test(w)) {
    w = w.replace(STEP1A_ES, '$1$2');
  } else if (STEP1A_S.test(w)) {
    w = w.replace(STEP1A_S, '$1$2');
  }

  // Step 1b
  const eed = STEP1B_EED.exec(w);
  if (eed) {
    if (MGR0.test(eed[1])) {
      w = w.replace(LAST_CHAR, '');
    }
  } else {
    const edIng = STEP1B_ED_ING.exec(w);
    if (edIng && CONTAINS_VOWEL.test(edIng[1])) {
      w = edIng[1];
      if (STEP1B_CVC_EXTENSION.test(w)) {
        w = w + 'e';
      } else if (STEP1B_DOUBLE_CONSONANT.test(w)) {
        w = w.replace(LAST_CHAR, '');
      } else if (CVC.test(w)) {
        w = w + 'e';
      }
    }
  }

  // Step 1c
  const endsInY = STEP1C_Y.exec(w);
  if (endsInY && CONTAINS_VOWEL.test(endsInY[1])) {
    w = endsInY[1] + 'i';
  }

  // Step 2
  const step2 = STEP2.exec(w);
  if (step2 && MGR0.test(step2[1])) {
    w = step2[1] + STEP2_SUFFIXES[step2[2]];
  }

  // Step 3
  const step3 = STEP3.exec(w);
  if (step3 && MGR0.test(step3[1])) {
    w = step3[1] + STEP3_SUFFIXES[step3[2]];
  }

  // Step 4
  const step4 = STEP4.exec(w);
  if (step4) {
    if (MGR1.test(step4[1])) {
      w = step4[1];
    }
  } else {
    const ion = STEP4_ION.exec(w);
    if (ion && MGR1.test(ion[1] + ion[2])) {
      w = ion[1] + ion[2];
    }
  }

  // Step 5
  const endsInE = STEP5_E.exec(w);
  if (
    endsInE &&
    (MGR1.test(endsInE[1]) || (MEQ1.test(endsInE[1]) && !CVC.test(endsInE[1])))
  ) {
    w = endsInE[1];
  }
  if (/ll$/.test(w) && MGR1.test(w)) {
    w = w.replace(LAST_CHAR, '');
  }

  // Restore an initial 'y' that was upper-cased for consonant handling.
  if (firstChar === 'y') {
    w = 'y' + w.substring(1);
  }

  return w;
}
