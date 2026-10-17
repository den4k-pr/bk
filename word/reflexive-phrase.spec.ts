// 🔒 Жодного реального OpenAI.
jest.mock('openai/client.js', () => ({ OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })) }));
jest.mock('openai', () => ({ OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })) }));

import { toNeutralReflexivePhrase } from './words-details/reflexive-phrase.util';
import { WordGenerationService } from './words-details/word-generation.service';

describe('фраза з -self → нейтральна форма з oneself', () => {
  it.each([
    ['demanding of himself', 'demanding of oneself'],
    ['demanding of herself', 'demanding of oneself'],
    ['demanding of themselves', 'demanding of oneself'],
    ['help yourself', 'help oneself'],
    ['make yourselves at home', 'make oneself at home'],
    ['proud of myself', 'proud of oneself'],
    ['enjoy ourselves', 'enjoy oneself'],
  ])('"%s" → "%s"', (input, expected) => {
    expect(toNeutralReflexivePhrase(input)).toBe(expected);
  });

  it.each(['in itself', 'by itself', 'himself', 'herself', 'give up', 'the self-made man', 'selfish of him'])('"%s" без змін', (input) => {
    expect(toNeutralReflexivePhrase(input)).toBe(input);
  });
});

describe('пошук і генерація фрази йдуть за нейтральною формою', () => {
  const qb = (one: any) => {
    const b: any = {};
    for (const m of ['select', 'addSelect', 'where', 'andWhere', 'orWhere', 'orderBy', 'addOrderBy', 'limit', 'take', 'skip', 'setParameter', 'setParameters']) b[m] = jest.fn(() => b);
    b.getOne = jest.fn(async () => one);
    b.getMany = jest.fn(async () => (one ? [one] : []));
    return b;
  };

  const build = (existing: Record<string, any>) => {
    const queries: string[] = [];
    const wordRepo: any = {
      createQueryBuilder: jest.fn(() => {
        const b = qb(null);
        b.where = jest.fn((_sql: string, params: any) => {
          const q = params?.q;
          if (typeof q === 'string') queries.push(q);
          b.getOne = jest.fn(async () => existing[q] ?? null);
          return b;
        });
        return b;
      }),
      findOne: jest.fn(async () => null),
    };
    const repo: any = { createQueryBuilder: jest.fn(() => qb(null)), findOne: jest.fn(async () => null) };
    const service = new WordGenerationService({ clear: jest.fn() } as any, wordRepo, repo, repo, { get: jest.fn(async () => null), set: jest.fn() } as any);
    for (const l of ['log', 'warn', 'error', 'debug'] as const) jest.spyOn((service as any).logger, l).mockImplementation(() => undefined);
    return { service, queries };
  };

  it('"demanding of himself" знаходить наявний запис "demanding of oneself" без AI', async () => {
    const entry = { id: 5, text: 'demanding of oneself', translation: 'вимогливий до себе' };
    const { service, queries } = build({ 'demanding of oneself': entry });
    await expect((service as any).findOrGenerateWord('demanding of himself')).resolves.toBe(entry);
    expect(queries[0]).toBe('demanding of oneself');
  });

  it('інші фрази шукаються як і раніше (регістр і текст не змінюються)', async () => {
    const entry = { id: 6, text: 'give up', translation: 'здаватися' };
    const { service, queries } = build({ 'give up': entry });
    await expect((service as any).findOrGenerateWord('give up')).resolves.toBe(entry);
    expect(queries[0]).toBe('give up');
  });
});
