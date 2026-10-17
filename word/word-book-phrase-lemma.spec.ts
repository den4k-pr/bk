// Фраза з книги не підміняється іншим словом через "лему" від AI.
// 🔒 Жодного реального OpenAI.
jest.mock('openai/client.js', () => ({ OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })) }));
jest.mock('openai', () => ({ OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })) }));

import { WordGenerationService } from './words-details/word-generation.service';

const build = () => {
  const repo: any = { createQueryBuilder: jest.fn(), findOne: jest.fn(), create: jest.fn(), save: jest.fn() };
  const service = new WordGenerationService({ clear: jest.fn() } as any, repo, repo, repo, { get: jest.fn(), set: jest.fn() } as any);
  for (const l of ['log', 'warn', 'error', 'debug'] as const) jest.spyOn((service as any).logger, l).mockImplementation(() => undefined);
  const accept = (candidate: string, original: string, reader: boolean) =>
    reader
      ? (service as any).lookupScope.run({ surface: original, rawContext: 'Some sentence here.', reader: true }, () =>
          (service as any).isAcceptedAiLemma(candidate, original))
      : (service as any).isAcceptedAiLemma(candidate, original);
  return { accept };
};

describe('лема AI для фрази з книги', () => {
  const { accept } = build();

  it.each([
    ['sting', 'sting of offense'],
    ['i am', "i'll be free"],
    ['be free', "i'll be free"],
    ['i will be free', "i'll be free"],
    ['pick up', 'picked her up'],
  ])('книга: "%s" для фрази "%s" — відхилено, лишається фраза', (candidate, original) => {
    expect(accept(candidate, original, true)).toBe(false);
  });

  it.each([
    ['give up on', 'gave up on'],
    ['sting of offence', 'sting of offense'],
    ['take off', 'took off'],
  ])('книга: "%s" для "%s" — та сама кількість слів, приймається', (candidate, original) => {
    expect(accept(candidate, original, true)).toBe(true);
  });

  it('одне слово в книзі — як і раніше (training → train)', () => {
    expect(accept('train', 'trained', true)).toBe(true);
  });

  it('поза книгою — як і раніше: фразу можна скоротити на одне слово', () => {
    expect(accept('pick up', 'picked her up', false)).toBe(true);
  });

  it('явне сміття відхиляється і поза книгою, і в книзі', () => {
    expect(accept('xx12', 'sting of offense', false)).toBe(false);
    expect(accept('xx12', 'sting of offense', true)).toBe(false);
  });
});
