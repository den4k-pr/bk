import {
  isUkrainianInfinitive,
  validateGeneratedEntry,
  validateUkrainianTranslation,
} from './generated-entry-validation';

const valid = {
  text: 'time machine',
  translation: 'машина часу',
  pronunciation: 'тайм машин',
  examples: [
    'He built a time machine.', 'Він збудував машину часу.',
    'She used the time machine.', 'Вона скористалась машиною часу.',
    'We will test the time machine.', 'Ми перевіримо машину часу.',
  ],
  isRealEnglishEntry: true,
};

describe('validateGeneratedEntry', () => {
  it('accepts a correct entry', () => {
    expect(validateGeneratedEntry(valid)).toEqual([]);
  });

  it('rejects keyboard-layout gibberish marked as not real', () => {
    expect(
      validateGeneratedEntry({ ...valid, text: 'vfibyf xfce', translation: 'переклад відсутній', isRealEnglishEntry: false }),
    ).toEqual(expect.arrayContaining(['translation_placeholder', 'model_not_real_entry']));
  });

  it('rejects long headwords without vowels but keeps abbreviations', () => {
    expect(validateGeneratedEntry({ ...valid, text: 'bcdfg' })).toContain('text_no_vowel');
    expect(validateGeneratedEntry({ ...valid, text: 'tv' })).not.toContain('text_no_vowel');
  });

  it('rejects Cyrillic headwords', () => {
    expect(validateGeneratedEntry({ ...valid, text: 'машина' })).toContain('text_not_latin');
  });

  it('rejects empty example slots (old forced padding)', () => {
    const examples = [...valid.examples];
    examples[5] = '';
    expect(validateGeneratedEntry({ ...valid, examples })).toContain('example_5_empty');
  });

  it('rejects a translation with hidden Latin letters', () => {
    expect(validateUkrainianTranslation('муcити')).toContain('translation_has_latin');
  });
});

describe('isUkrainianInfinitive', () => {
  it.each(['ходити', 'розповідати', 'могти', 'вчитися', 'пекти'])('%s is an infinitive', w => {
    expect(isUkrainianInfinitive(w)).toBe(true);
  });
  it.each(['йду', 'розповідає', 'кипить', 'ходить', 'не сказавши'])('%s is not an infinitive', w => {
    expect(isUkrainianInfinitive(w)).toBe(false);
  });
});
