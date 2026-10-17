import { resolveEntryType } from './entry-type';
import { classifyQueryStructure } from './phrase-structure-classifier';

const typeOf = (text: string, pos: string | null = null) => resolveEntryType(text, pos, classifyQueryStructure(text).type);

describe('тип запису словника', () => {
  it.each([
    ['cat', 'word'],
    ['well-known', 'word'],
    ["don't", 'word'],
    ['i love cats', 'phrase'],
    ['in order to', 'phrase'],
    ['again and again', 'phrase'],
    ['kick the bucket', 'phrase'],
    ['locker room', 'phrase'],
    ['give up', 'phrasal_verb'],
    ['look after', 'phrasal_verb'],
  ])('%s → %s', (text, expected) => {
    expect(typeOf(text)).toBe(expected);
  });

  it('частина мови phrasal_verb від AI → фразове дієслово', () => {
    expect(resolveEntryType('figure it out', 'phrasal_verb', 'idiom')).toBe('phrasal_verb');
  });
});

describe('фрази з кількох слів', () => {
  it.each(['time machine', 'running shoes', 'boiled eggs', 'book club'])('%s — фраза, лема не зводиться до дієслова', q => {
    const s = classifyQueryStructure(q);
    expect(s.headVerbLemma).toBeUndefined();
    expect(resolveEntryType(q, null, s.type)).toBe('phrase');
  });

  it('kicked the bucket — ідіома з лемою kick', () => {
    expect(classifyQueryStructure('kicked the bucket').headVerbLemma).toBe('kick');
  });

  it('give up — фразове дієслово', () => {
    const s = classifyQueryStructure('give up');
    expect(resolveEntryType('give up', null, s.type)).toBe('phrasal_verb');
  });
});
