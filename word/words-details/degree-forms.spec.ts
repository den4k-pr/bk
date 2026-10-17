import { computeDegreeForms } from './degree-forms';

const adj = (w: string) => computeDegreeForms(w, 'adjective');
const adv = (w: string) => computeDegreeForms(w, 'adverb');

describe('computeDegreeForms', () => {
  it('односкладові прикметники: -er/-est', () => {
    expect(adj('big')).toEqual(['bigger', 'biggest']);
    expect(adj('fast')).toEqual(['faster', 'fastest']);
  });

  it('прикметники на -y: -ier/-iest', () => {
    expect(adj('happy')).toEqual(['happier', 'happiest']);
  });

  it('багатоскладові прикметники: more/most', () => {
    expect(adj('beautiful')).toEqual(['more beautiful', 'most beautiful']);
  });

  it('неправильні прикметники', () => {
    expect(adj('good')).toEqual(['better', 'best']);
    expect(adj('bad')).toEqual(['worse', 'worst']);
  });

  it('неградуальні прикметники — порожньо', () => {
    expect(adj('french')).toEqual([]);
    expect(adj('perfect')).toEqual([]);
    expect(adj('dead')).toEqual([]);
  });

  it('слова на -ing — порожньо', () => {
    expect(adj('interesting')).toEqual([]);
    expect(computeDegreeForms('running', 'verb')).toEqual([]);
  });

  it('-ed дієприкметникові прикметники — more/most', () => {
    expect(adj('tired')).toEqual(['more tired', 'most tired']);
    expect(adj('bored')).toEqual(['more bored', 'most bored']);
  });

  it('прислівники на -ly — more/most', () => {
    expect(adv('quickly')).toEqual(['more quickly', 'most quickly']);
    expect(adv('slowly')).toEqual(['more slowly', 'most slowly']);
  });

  it('неправильні прислівники', () => {
    expect(adv('well')).toEqual(['better', 'best']);
    expect(adv('badly')).toEqual(['worse', 'worst']);
    expect(adv('early')).toEqual(['earlier', 'earliest']);
  });

  it('неградуальні прислівники — порожньо', () => {
    expect(adv('very')).toEqual([]);
    expect(adv('now')).toEqual([]);
    expect(adv('here')).toEqual([]);
    expect(adv('always')).toEqual([]);
  });

  it('плоскі прислівники — -er/-est', () => {
    expect(adv('hard')).toEqual(['harder', 'hardest']);
    expect(adv('fast')).toEqual(['faster', 'fastest']);
  });

  it('дієслова/іменники/фрази — порожньо (без дублювання)', () => {
    expect(computeDegreeForms('go', 'verb')).toEqual([]);
    expect(computeDegreeForms('walk', 'verb')).toEqual([]);
    expect(computeDegreeForms('house', 'noun')).toEqual([]);
    expect(computeDegreeForms('give up', 'phrasal_verb')).toEqual([]);
  });

  it('без штучного дублювання: кілька форм там, де вони реально є', () => {
    expect(adv('far')).toEqual(['farther', 'further', 'farthest', 'furthest']);
    expect(adv('often')).toEqual(['more often', 'most often']);
  });

  it('порядкові числівники — порожньо', () => {
    expect(adj('third')).toEqual([]);
    expect(adj('seventh')).toEqual([]);
    expect(adj('sixteenth')).toEqual([]);
  });

  it('слова, що вже є ступенем порівняння, — порожньо', () => {
    expect(adj('further')).toEqual([]);
    expect(adj('better')).toEqual([]);
    expect(adv('further')).toEqual([]);
    expect(adv('worst')).toEqual([]);
  });

  it('частка not — порожньо', () => {
    expect(adv('not')).toEqual([]);
  });
});

describe('прислівники способу дії (simply, fairly…) — мають ступені', () => {
  it.each([
    ['simply', ['more simply', 'most simply']],
    ['fairly', ['more fairly', 'most fairly']],
    ['fully', ['more fully', 'most fully']],
    ['suddenly', ['more suddenly', 'most suddenly']],
  ])('%s', (word, forms) => {
    expect(computeDegreeForms(word, 'adverb')).toEqual(forms);
  });
  it('підсилювачі й частки лишаються без форм', () => {
    expect(computeDegreeForms('just', 'adverb')).toEqual([]);
    expect(computeDegreeForms('very', 'adverb')).toEqual([]);
    expect(computeDegreeForms('merely', 'adverb')).toEqual([]);
  });
});
