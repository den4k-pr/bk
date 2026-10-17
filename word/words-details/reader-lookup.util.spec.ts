import { buildVerbForms, isAuxiliaryInVerbGroup, normalizeLookupQuery, withoutIngForms } from './reader-lookup.util';

describe('normalizeLookupQuery', () => {
  it('прибирає невидимі символи всередині слова', () => {
    expect(normalizeLookupQuery('wro­ng')).toBe('wrong');
    expect(normalizeLookupQuery('﻿wrong​')).toBe('wrong');
    expect(normalizeLookupQuery('  give  up ')).toBe('give up');
  });

  it('зводить лігатури до звичайних літер', () => {
    expect(normalizeLookupQuery('ﬁnd')).toBe('find');
  });

  it('замінює кириличні двійники лише в латинському слові', () => {
    expect(normalizeLookupQuery('wrоng')).toBe('wrong'); // кирилична "о"
    expect(normalizeLookupQuery('Сat')).toBe('Cat'); // кирилична "С"
    expect(normalizeLookupQuery('рука')).toBe('рука');
    expect(normalizeLookupQuery('машина часу')).toBe('машина часу');
    expect(normalizeLookupQuery('wrжng')).toBe('wrжng');
  });

  it('не змінює звичайні запити', () => {
    expect(normalizeLookupQuery("don't")).toBe("don't");
    expect(normalizeLookupQuery('well-known')).toBe('well-known');
    expect(normalizeLookupQuery('')).toBe('');
  });
});

describe('buildVerbForms', () => {
  it('неправильні дієслова', () => {
    expect(buildVerbForms({ text: 'go', partOfSpeech: 'verb' })).toEqual(['went', 'gone']);
    expect(buildVerbForms({ text: 'have', partOfSpeech: 'verb' })).toEqual(['had', 'had']);
    expect(buildVerbForms({ text: 'be', partOfSpeech: 'verb' })).toEqual(['was / were', 'been']);
  });

  it('правильні дієслова — БЕЗ форм (форми лише для неправильних)', () => {
    for (const text of ['walk', 'stop', 'imagine', 'prefer', 'admit', 'visit', 'open', 'study', 'play', 'include', 'describe']) {
      expect(buildVerbForms({ text, partOfSpeech: 'verb' })).toBeNull();
    }
  });

  it('неправильні дієслова — без -ing', () => {
    const forms = (text: string) => buildVerbForms({ text, partOfSpeech: 'verb' });
    expect(forms('run')).toEqual(['ran', 'run']);
    expect(forms('begin')).toEqual(['began', 'begun']);
    expect(forms('make')).toEqual(['made', 'made']);
    expect(forms('see')).toEqual(['saw', 'seen']);
    expect(forms('lie')).toEqual(['lay', 'lain']);
    expect(forms('get')).toEqual(['got', 'got / gotten']);
    expect(forms('put')).toEqual(['put', 'put']);
    expect(forms('quit')).toEqual(['quit / quitted', 'quit / quitted']);
  });

  it('фразові дієслова — форми НІКОЛИ не виводяться (навіть з неправильним дієсловом)', () => {
    const phrasal = (text: string) => buildVerbForms({ text, partOfSpeech: 'phrasal_verb', type: 'phrasal_verb' });
    for (const text of ['give up', 'look after', 'wake someone up', 'get by', 'take off']) {
      expect(phrasal(text)).toBeNull();
    }
    // Тип "фразове дієслово" з книги при іншій частині мови / одне слово з таким типом.
    expect(buildVerbForms({ text: 'give up', partOfSpeech: 'verb', type: 'phrasal_verb' })).toBeNull();
    expect(buildVerbForms({ text: 'give up', partOfSpeech: 'verb' })).toBeNull();
    expect(buildVerbForms({ text: 'go', partOfSpeech: 'verb', type: 'phrasal_verb' })).toBeNull();
  });

  it('не дієслова і модальні — без форм', () => {
    expect(buildVerbForms({ text: 'wrong', partOfSpeech: 'adjective' })).toBeNull();
    expect(buildVerbForms({ text: 'can', partOfSpeech: 'verb' })).toBeNull();
    expect(buildVerbForms({ text: 'do not', partOfSpeech: 'verb' })).toBeNull();
    expect(buildVerbForms({ text: 'in order to', partOfSpeech: 'phrase', type: 'phrase' })).toBeNull();
    expect(buildVerbForms({ text: '', partOfSpeech: 'verb' })).toBeNull();
    expect(buildVerbForms({ text: 'train', partOfSpeech: null })).toBeNull();
  });

  it('хибно позначені записи словника — без форм', () => {
    const phrasal = (text: string) => buildVerbForms({ text, partOfSpeech: 'phrasal_verb', type: 'phrasal_verb' });
    for (const text of ['at the time', 'little by little', 'in order to', 'right now', 'coffee shop', 'are not',
      'been in', 'have done', 'paused for effect', 'like this', 'each other', 'too late']) {
      expect(phrasal(text)).toBeNull();
    }
    expect(buildVerbForms({ text: 'taught', partOfSpeech: 'verb' })).toBeNull();
    expect(buildVerbForms({ text: 'telling', partOfSpeech: 'verb' })).toBeNull();
  });
});

describe('withoutIngForms', () => {
  it('прибирає -ing зі старих записів БД', () => {
    expect(withoutIngForms(['included', 'including'])).toEqual(['included']);
    expect(withoutIngForms(['more interesting', 'most interesting'])).toEqual([]);
    expect(withoutIngForms(['giving up', 'gave up'])).toEqual(['gave up']);
  });

  it('не чіпає -ing у решті фрази та ступені', () => {
    expect(withoutIngForms(['gave something up'])).toEqual(['gave something up']);
    expect(withoutIngForms(['bigger', 'biggest', 'more quickly'])).toEqual(['bigger', 'biggest', 'more quickly']);
  });
});

describe('isAuxiliaryInVerbGroup', () => {
  it('допоміжне слово в групі', () => {
    expect(isAuxiliaryInVerbGroup('had', { verbGroup: 'had imagined', tense: 'past_perfect' })).toBe(true);
    expect(isAuxiliaryInVerbGroup('was', { verbGroup: 'was not telling', tense: 'past_continuous' })).toBe(true);
    expect(isAuxiliaryInVerbGroup('been', { verbGroup: 'has been told', function: 'passive' })).toBe(true);
    expect(isAuxiliaryInVerbGroup('did', { verbGroup: "didn't go", tense: 'past_simple' })).toBe(false);
    expect(isAuxiliaryInVerbGroup('did', { verbGroup: 'did not go', tense: 'past_simple' })).toBe(true);
  });

  it('головне дієслово групи — не допоміжне', () => {
    expect(isAuxiliaryInVerbGroup('imagined', { verbGroup: 'had imagined', tense: 'past_perfect' })).toBe(false);
    expect(isAuxiliaryInVerbGroup('walking', { verbGroup: 'am walking', tense: 'present_continuous' })).toBe(false);
    expect(isAuxiliaryInVerbGroup('had', { verbGroup: 'had', tense: 'past_simple' })).toBe(false);
  });

  it('без групи — за часом', () => {
    expect(isAuxiliaryInVerbGroup('had', { verbGroup: null, tense: 'past_perfect' })).toBe(true);
    expect(isAuxiliaryInVerbGroup('had', { verbGroup: null, tense: 'past_simple' })).toBe(false);
    expect(isAuxiliaryInVerbGroup('will', { verbGroup: null, tense: 'future' })).toBe(true);
    expect(isAuxiliaryInVerbGroup('telling', { verbGroup: null, tense: 'past_continuous' })).toBe(false);
  });
});
