import { contextCue } from './context-cues';

describe('context-cues', () => {
  it.each([
    ['train', 'The train was late', 'determiner'],
    ['lives', "Many fighters carry their fathers' lives on their shoulders", 'determiner'],
    ['hands', "Ivan's hands were shaking", 'determiner'],
    ['trains', 'He trains every day', 'subject'],
    ['train', 'Tomorrow you will train for yourself', 'modal'],
    ['training', 'She was training hard', 'be'],
    ['seen', 'He had seen many young people', 'have'],
    ['train', 'I want to train', 'to'],
    ['watch', 'They sat and watch TV', 'weak_verb'],
  ])('%s у «%s» → %s', (word, ctx, cue) => {
    expect(contextCue(word, ctx)).toBe(cue);
  });

  it('немає підказки: невідоме попереднє слово або слово не знайдено', () => {
    expect(contextCue('trained', 'He noticed how hard the young man trained')).toBeNull();
    expect(contextCue('wooden', 'sit down on the bench')).toBeNull();
  });

  it("it's / he's — не присвійні форми", () => {
    expect(contextCue('late', "It's late")).toBeNull();
  });

  it('повтор слова успадковує підказку: "for a long, long time" → determiner', () => {
    expect(contextCue('long', 'staring at one empty spot on the floor for a long, long time.')).toBe('determiner');
  });

  it('кілька входжень з різними підказками → немає підказки', () => {
    expect(contextCue('watch', 'I watch his watch')).toBeNull();
  });

  it('her — не артикль (бо "watched her train"), а лише слабкий сигнал дієслова; all / both — без підказки', () => {
    expect(contextCue('train', 'I watched her train')).toBe('weak_verb');
    expect(contextCue('trained', 'They all trained hard')).toBeNull();
    expect(contextCue('fight', 'just to watch him fight')).toBe('weak_verb');
  });

  it.each([
    ['telling', 'She kept telling me the truth', 'gerund'],
    ['telling', 'He left without telling anyone', 'gerund'],
    ['walking', 'He was slowly walking home', 'be'],
    ['telling', 'She was not telling the truth', 'be'],
  ])('-ing з кількома попередніми словами: %s у «%s» → %s', (word, ctx, cue) => {
    expect(contextCue(word, ctx)).toBe(cue);
  });
});
