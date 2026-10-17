import { analyzeInflections, inflectionKindOf, isPosCompatibleWithKind, generateVerbForms } from './inflection';

const lemmasOf = (surface: string, pos?: string) =>
  analyzeInflections(surface)
    .filter(a => !pos || a.pos === pos)
    .map(a => a.lemma);

describe('inflection: словотвір НЕ зводиться до кореня', () => {
  it.each([
    ['wooden', 'wood'], ['golden', 'gold'], ['woollen', 'wool'], ['silken', 'silk'], ['earthen', 'earth'],
    ['kitchen', 'kitch'], ['careful', 'care'], ['happiness', 'happy'], ['quickly', 'quick'], ['often', 'oft'],
    ['frighten', 'fright'], ['threaten', 'threat'], ['strengthen', 'strength'], ['childhood', 'child'],
  ])('%s не є формою "%s"', (word, root) => {
    expect(inflectionKindOf(word, root)).toBeNull();
    expect(analyzeInflections(word).map(a => a.lemma)).not.toContain(root);
  });

  it('teacher ≠ teach як дієслово (морфологічно це лише "ступінь" прикметника — відсікається частиною мови)', () => {
    expect(inflectionKindOf('teacher', 'teach', 'verb')).toBeNull();
    expect(inflectionKindOf('teacher', 'teach', 'noun')).toBeNull();
    expect(isPosCompatibleWithKind('verb', 'adj_comparative')).toBe(false);
  });
});

describe('inflection: правильні дієслова', () => {
  it.each([
    ['trained', 'train', 'verb_past'],
    ['trains', 'train', 'verb_3sg'],
    ['training', 'train', 'verb_ing'],
    ['watched', 'watch', 'verb_past'],
    ['watches', 'watch', 'verb_3sg'],
    ['watching', 'watch', 'verb_ing'],
    ['noticed', 'notice', 'verb_past'],
    ['pushing', 'push', 'verb_ing'],
    ['punishing', 'punish', 'verb_ing'],
    ['staring', 'stare', 'verb_ing'],
    ['hoping', 'hope', 'verb_ing'],
    ['hoped', 'hope', 'verb_past'],
    ['stopped', 'stop', 'verb_past'],
    ['stopping', 'stop', 'verb_ing'],
    ['visited', 'visit', 'verb_past'],
    ['listened', 'listen', 'verb_past'],
    ['opened', 'open', 'verb_past'],
    ['happened', 'happen', 'verb_past'],
    ['covered', 'cover', 'verb_past'],
    ['tried', 'try', 'verb_past'],
    ['tries', 'try', 'verb_3sg'],
    ['studying', 'study', 'verb_ing'],
    ['played', 'play', 'verb_past'],
    ['dying', 'die', 'verb_ing'],
    ['lying', 'lie', 'verb_ing'],
    ['seeing', 'see', 'verb_ing'],
    ['agreed', 'agree', 'verb_past'],
    ['panicked', 'panic', 'verb_past'],
    ['quitting', 'quit', 'verb_ing'],
    ['travelled', 'travel', 'verb_past'],
    ['traveled', 'travel', 'verb_past'],
    ['preferred', 'prefer', 'verb_past'],
    ['changed', 'change', 'verb_past'],
    ['changing', 'change', 'verb_ing'],
    ['danced', 'dance', 'verb_past'],
    ['served', 'serve', 'verb_past'],
    ['fixes', 'fix', 'verb_3sg'],
    ['goes', 'go', 'verb_3sg'],
    ['booked', 'book', 'verb_past'],
    ['faced', 'face', 'verb_past'],
    ['moving', 'move', 'verb_ing'],
    ['talking', 'talk', 'verb_ing'],
  ])('%s → %s (%s)', (surface, lemma, kind) => {
    expect(inflectionKindOf(surface, lemma, 'verb')).toBe(kind);
    expect(lemmasOf(surface, 'verb')).toContain(lemma);
  });

  it('односкладові CVC подвоюють обовʼязково: hoping ≠ hop, staring ≠ star, planed ≠ plan', () => {
    expect(inflectionKindOf('hoping', 'hop', 'verb')).toBeNull();
    expect(inflectionKindOf('hoped', 'hop', 'verb')).toBeNull();
    expect(inflectionKindOf('staring', 'star', 'verb')).toBeNull();
    expect(inflectionKindOf('planed', 'plan', 'verb')).toBeNull();
    expect(inflectionKindOf('hopped', 'hop', 'verb')).toBe('verb_past');
    expect(inflectionKindOf('starring', 'star', 'verb')).toBe('verb_ing');
  });
});

describe('inflection: неправильні дієслова', () => {
  it.each([
    ['went', 'go'], ['gone', 'go'], ['grew', 'grow'], ['grown', 'grow'], ['sat', 'sit'], ['left', 'leave'],
    ['saw', 'see'], ['seen', 'see'], ['found', 'find'], ['felt', 'feel'], ['thought', 'think'], ['brought', 'bring'],
    ['taught', 'teach'], ['caught', 'catch'], ['written', 'write'], ['wrote', 'write'], ['was', 'be'], ['were', 'be'],
    ['had', 'have'], ['did', 'do'], ['done', 'do'], ['slain', 'slay'], ['slew', 'slay'], ['strung', 'string'],
    ['sewn', 'sew'], ['wrung', 'wring'], ['misled', 'mislead'], ['understood', 'understand'], ['retook', 'retake'],
    ['lay', 'lie'], ['lain', 'lie'], ['born', 'bear'], ['woke', 'wake'], ['began', 'begin'], ['swum', 'swim'],
  ])('%s → %s', (surface, lemma) => {
    expect(lemmasOf(surface, 'verb')).toContain(lemma);
  });

  it('is/has — 3-тя особа be/have', () => {
    expect(inflectionKindOf('is', 'be', 'verb')).toBe('verb_3sg');
    expect(inflectionKindOf('has', 'have', 'verb')).toBe('verb_3sg');
  });

  it('неправильні дієслова не мають вигаданих правильних форм', () => {
    const go = generateVerbForms('go');
    expect(go.past.has('goed')).toBe(false);
    expect(go.past.has('went')).toBe(true);
    expect(generateVerbForms('find').past.has('finded')).toBe(false);
  });
});

describe('inflection: іменники', () => {
  it.each([
    ['books', 'book'], ['buses', 'bus'], ['glasses', 'glass'], ['boxes', 'box'], ['cities', 'city'], ['days', 'day'],
    ['knives', 'knife'], ['wolves', 'wolf'], ['lives', 'life'], ['leaves', 'leaf'], ['potatoes', 'potato'],
    ['children', 'child'], ['men', 'man'], ['women', 'woman'], ['firemen', 'fireman'], ['people', 'person'],
    ['feet', 'foot'], ['teeth', 'tooth'], ['geese', 'goose'], ['mice', 'mouse'], ['analyses', 'analysis'],
    ['cacti', 'cactus'], ['data', 'datum'], ['criteria', 'criterion'], ['benches', 'bench'], ['spots', 'spot'],
  ])('%s → %s', (surface, lemma) => {
    expect(inflectionKindOf(surface, lemma, 'noun')).toBe('noun_plural');
  });

  it('множина не утворюється від хибних основ', () => {
    expect(inflectionKindOf('news', 'new', 'noun')).toBe('noun_plural'); // морфологічно так, тому news — у STANDALONE_WORDS
    expect(lemmasOf('bus')).not.toContain('bu');
  });
});

describe('inflection: ступені порівняння', () => {
  it.each([
    ['bigger', 'big', 'adj_comparative'], ['biggest', 'big', 'adj_superlative'], ['larger', 'large', 'adj_comparative'],
    ['happier', 'happy', 'adj_comparative'], ['easiest', 'easy', 'adj_superlative'], ['older', 'old', 'adj_comparative'],
    ['better', 'good', 'adj_comparative'], ['best', 'good', 'adj_superlative'], ['worse', 'bad', 'adj_comparative'],
    ['worst', 'bad', 'adj_superlative'], ['further', 'far', 'adj_comparative'], ['faster', 'fast', 'adj_comparative'],
    ['quieter', 'quiet', 'adj_comparative'], ['longest', 'long', 'adj_superlative'],
  ])('%s → %s (%s)', (surface, lemma, kind) => {
    expect(inflectionKindOf(surface, lemma, 'adjective')).toBe(kind);
  });

  it('суплетивні слова лишаються окремими: last ≠ late, next ≠ nigh, elder ≠ old', () => {
    expect(lemmasOf('last', 'adjective')).not.toContain('late');
    expect(lemmasOf('next', 'adjective')).not.toContain('nigh');
    expect(lemmasOf('elder', 'adjective')).not.toContain('old');
  });
});

describe('inflection: сумісність частини мови запису з формою', () => {
  it('-ed / -ing — лише від дієслова', () => {
    expect(isPosCompatibleWithKind('noun', 'verb_past')).toBe(false);
    expect(isPosCompatibleWithKind('noun', 'verb_ing')).toBe(false);
    expect(isPosCompatibleWithKind('verb', 'verb_past')).toBe(true);
  });
  it('множина — лише від іменника (і числівника/займенника)', () => {
    expect(isPosCompatibleWithKind('noun', 'noun_plural')).toBe(true);
    expect(isPosCompatibleWithKind('numeral', 'noun_plural')).toBe(true);
    expect(isPosCompatibleWithKind('verb', 'noun_plural')).toBe(false);
  });
  it('ступені — лише від прикметника/прислівника; невідома частина мови не допускається', () => {
    expect(isPosCompatibleWithKind('adjective', 'adj_comparative')).toBe(true);
    expect(isPosCompatibleWithKind('adverb', 'adj_comparative')).toBe(true);
    expect(isPosCompatibleWithKind('noun', 'adj_comparative')).toBe(false);
    expect(isPosCompatibleWithKind(null, 'adj_comparative')).toBe(false);
    expect(isPosCompatibleWithKind(null, 'verb_past')).toBe(true);
  });
});
