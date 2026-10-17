import { resolveQuantityAdjective } from './quantity-adjectives';
import { classifyQueryStructure } from './phrase-structure-classifier';

describe('quantity-adjectives', () => {
  it('better / best — форми "good" (а не "well"), worse — "bad"', () => {
    expect(resolveQuantityAdjective('better')?.base).toBe('good');
    expect(resolveQuantityAdjective('best')?.base).toBe('good');
    expect(resolveQuantityAdjective('worse')?.base).toBe('bad');
    expect(resolveQuantityAdjective('well')?.base).toBe('well');
  });

  it('суплетивні слова — окремі: first, last, next, former, elder, latter', () => {
    for (const w of ['first', 'last', 'next', 'former', 'elder', 'latter', 'foremost']) {
      expect(resolveQuantityAdjective(w)).toBeNull();
    }
  });

  it('"first" класифікується як порядковий числівник, а не як форма "fore"', () => {
    const s = classifyQueryStructure('first');
    expect(s.partOfSpeech).toBe('numeral');
    expect(s.headAdjectiveLemma).toBeUndefined();
  });
});
