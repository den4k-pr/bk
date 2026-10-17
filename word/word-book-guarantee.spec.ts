// Три правила читалки:
//  1. Гарантія перекладу: тап у книзі завжди дає збережений запис з перекладом;
//     відмова можлива лише коли на OpenAI немає коштів або AI / сервер недоступний.
//  2. Кілька слів із книги — завжди тип "фразове дієслово".
//  3. Форми — лише для неправильних дієслів; на фразових — ніколи.
// 🔒 Жодного реального OpenAI.
const openAiCreate = jest.fn();
jest.mock('openai/client.js', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openAiCreate } } })),
}));
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openAiCreate } } })),
}));

import { InternalServerErrorException, ServiceUnavailableException } from '@nestjs/common';
import { GenerationRejectedError, WordGenerationService } from './words-details/word-generation.service';
import { WordService } from './word.service';

const SENTENCE = 'He described the house in detail';
const reply = (obj: unknown) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });

type Mode = { translation?: string | (() => string); fail?: () => never };

const build = (mode: Mode = {}) => {
  const calls: string[] = [];
  openAiCreate.mockReset();
  openAiCreate.mockImplementation(async (req: any) => {
    const name = req.response_format?.json_schema?.name;
    calls.push(name);
    if (mode.fail) mode.fail();
    if (name === 'guaranteed_translation_v1') {
      const translation = typeof mode.translation === 'function' ? mode.translation() : mode.translation ?? 'описувати';
      return reply({ translation, partOfSpeech: 'verb' });
    }
    if (name === 'pronunciation_cyrillic_v1') return reply({ pronunciation: 'діскрайб' });
    if (name === 'examples_repair_v1') return reply({ examples: ['I describe it', 'Я це описую', 'Describe him', 'Опиши його'] });
    throw new Error(`unexpected request ${name}`);
  });
  const saved: any[] = [];
  const wordRepo: any = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(async () => null),
    create: jest.fn((d: any) => ({ ...d })),
    save: jest.fn(async (d: any) => {
      const row = { ...d, id: 700 + saved.length };
      saved.push(row);
      return row;
    }),
  };
  const store = new Map<string, unknown>();
  const aiCache = {
    get: jest.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
    set: jest.fn(async (k: string, _t: string, v: unknown) => void store.set(k, v)),
  };
  const service = new WordGenerationService({ clear: jest.fn() } as any, wordRepo, {} as any, {} as any, aiCache as any);
  for (const l of ['log', 'warn', 'error', 'debug'] as const) jest.spyOn((service as any).logger, l).mockImplementation(() => undefined);
  const main = jest.spyOn(service as any, 'findOrGenerateWord');
  return { service, wordRepo, calls, saved, main };
};

beforeEach(() => {
  (WordGenerationService as any).openAiQuotaBlockedUntil = null;
  (WordGenerationService as any).openAiOutOfFundsUntil = null;
});

describe('1. Гарантія перекладу для тапу в книзі', () => {
  it('звичайний випадок — основний шлях, без жодних запасних запитів', async () => {
    const t = build();
    const word = { id: 5, text: 'describe', translation: 'описувати' };
    t.main.mockResolvedValue(word);
    await expect(t.service.searchOrCreateGlobalWord('described', undefined, SENTENCE, { reader: true })).resolves.toBe(word);
    expect(t.main).toHaveBeenCalledTimes(1);
    expect(t.calls).toEqual([]);
  });

  it('запис відхилено перевіркою → НЕ "переклад не знайдено", а збережений запис з перекладом від GPT', async () => {
    const t = build();
    t.main.mockRejectedValue(new GenerationRejectedError('describe', ['translation_empty']));
    const word = await t.service.searchOrCreateGlobalWord('described', undefined, SENTENCE, { reader: true });
    expect(word).toMatchObject({ id: 700, text: 'describe', translation: 'описувати', pronunciation: 'діскрайб', type: 'word' });
    expect(word.examples).toHaveLength(4);
    expect((word as any).transient).toBeUndefined();
    expect(t.calls).toContain('guaranteed_translation_v1');
  });

  it('тимчасовий збій AI (таймаут, обрив потоку) → один повтор основного шляху', async () => {
    const t = build();
    const word = { id: 5, text: 'describe', translation: 'описувати' };
    t.main.mockRejectedValueOnce(new InternalServerErrorException('Не вдалося виконати запит через AI')).mockResolvedValueOnce(word);
    await expect(t.service.searchOrCreateGlobalWord('described', undefined, SENTENCE, { reader: true })).resolves.toBe(word);
    expect(t.main).toHaveBeenCalledTimes(2);
    expect(t.calls).toEqual([]);
  });

  it('основний шлях упав двічі → гарантований запис (переклад є, id справжній)', async () => {
    const t = build();
    t.main.mockRejectedValue(new InternalServerErrorException('Не вдалося виконати запит через AI'));
    const word = await t.service.searchOrCreateGlobalWord('described', undefined, SENTENCE, { reader: true });
    expect(word).toMatchObject({ id: 700, translation: 'описувати' });
    expect(t.main).toHaveBeenCalledTimes(2);
  });

  it('коротка пауза "забагато запитів" перечікується, а не стає відмовою', async () => {
    const t = build();
    const word = { id: 5, text: 'describe', translation: 'описувати' };
    t.main.mockImplementationOnce(async () => {
      (WordGenerationService as any).openAiQuotaBlockedUntil = Date.now() + 120;
      throw new ServiceUnavailableException('Сервіс генерації слів перевантажений');
    });
    t.main.mockResolvedValueOnce(word);
    const startedAt = Date.now();
    await expect(t.service.searchOrCreateGlobalWord('described', undefined, SENTENCE, { reader: true })).resolves.toBe(word);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
  });

  it('GPT двічі повернув порожній переклад → третя спроба; результат усе одно є', async () => {
    const answers = ['', 'no translation', 'описувати'];
    const t = build({ translation: () => answers.shift() ?? 'описувати' });
    t.main.mockRejectedValue(new GenerationRejectedError('describe', ['translation_empty']));
    await expect(t.service.searchOrCreateGlobalWord('described', undefined, SENTENCE, { reader: true })).resolves.toMatchObject({
      translation: 'описувати',
    });
  });

  it('GPT тричі не дав українського перекладу → транслітерація як переклад (не порожньо)', async () => {
    const t = build({ translation: '' });
    t.main.mockRejectedValue(new GenerationRejectedError('describe', ['translation_empty']));
    const word = await t.service.searchOrCreateGlobalWord('described', undefined, SENTENCE, { reader: true });
    expect(word.translation).toBe('діскрайб');
    expect(word.id).toBe(700);
  });

  it('слово вже є в базі → гарантований шлях повертає його без запитів до GPT', async () => {
    const t = build();
    const existing = { id: 9, text: 'describe', translation: 'описувати' };
    t.wordRepo.findOne.mockResolvedValue(existing);
    t.main.mockRejectedValue(new GenerationRejectedError('describe', ['translation_empty']));
    await expect(t.service.searchOrCreateGlobalWord('described', undefined, SENTENCE, { reader: true })).resolves.toBe(existing);
    expect(t.calls).toEqual([]);
  });

  it('ДОЗВОЛЕНА відмова 1: на OpenAI немає коштів (нове слово) → 503', async () => {
    const t = build();
    t.main.mockImplementation(async () => {
      (WordGenerationService as any).openAiQuotaBlockedUntil = Date.now() + 60_000;
      (WordGenerationService as any).openAiOutOfFundsUntil = Date.now() + 60_000;
      throw new ServiceUnavailableException('вичерпано ліміт AI');
    });
    await expect(t.service.searchOrCreateGlobalWord('described', undefined, SENTENCE, { reader: true })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(t.main).toHaveBeenCalledTimes(1);
    expect(t.calls).toEqual([]);
  });

  it('ДОЗВОЛЕНА відмова 2: AI повністю недоступний (усі спроби) → помилка сервера', async () => {
    const t = build({
      fail: () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { status: 500 });
      },
    });
    t.main.mockRejectedValue(new InternalServerErrorException('Не вдалося виконати запит через AI'));
    await expect(t.service.searchOrCreateGlobalWord('described', undefined, SENTENCE, { reader: true })).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  }, 15_000);

  it('поза книгою (ручний ввід) — як і раніше: відхилений запис не зберігається', async () => {
    const t = build();
    t.main.mockRejectedValue(new GenerationRejectedError('vfibyf', ['model_not_real_entry']));
    const transient = jest.spyOn(t.service as any, 'buildTransientWord').mockResolvedValue({ id: 0, transient: true });
    await expect(t.service.searchOrCreateGlobalWord('vfibyf')).resolves.toMatchObject({ id: 0 });
    expect(transient).toHaveBeenCalled();
    expect(t.saved).toHaveLength(0);
  });
});

describe('2. Кілька слів із книги — завжди фразове дієслово', () => {
  const buildService = (word: any) => {
    const wordRepo: any = { update: jest.fn(async () => undefined), save: jest.fn(async (w: any) => w), findOne: jest.fn(async () => null) };
    const cache: any = { set: jest.fn(async () => undefined), get: jest.fn(), clear: jest.fn(async () => undefined), clearByPattern: jest.fn(async () => undefined) };
    const gen: any = { searchOrCreateGlobalWord: jest.fn(async () => word), analyzeSurfaceInContext: jest.fn(async () => null) };
    const service = new WordService(wordRepo, { findOne: jest.fn(async () => null) } as any, {} as any, {} as any, {} as any, cache, {} as any, gen, {} as any, {} as any);
    for (const l of ['log', 'warn', 'error'] as const) jest.spyOn((service as any).logger, l).mockImplementation(() => undefined);
    return { service, wordRepo, gen };
  };
  const entry = (over: Record<string, unknown>) => ({ id: 30, text: 'by the way', type: 'phrase', partOfSpeech: 'phrase', translation: 'до речі', examples: [], exampleHighlights: [], forms: [], ...over });

  it('вираз лежить у системі як "фраза" → з книги стає фразовим дієсловом (у БД і у відповіді)', async () => {
    const t = buildService(entry({}));
    const res = await t.service.searchOrCreateGlobalWord(7, 'by the way', undefined, 'By the way, he left');
    expect(res.word.type).toBe('phrasal_verb');
    expect(t.wordRepo.update).toHaveBeenCalledWith(30, { type: 'phrasal_verb' });
  });

  it('старий багатослівний запис з типом "word" → теж фразове дієслово', async () => {
    const t = buildService(entry({ type: 'word', text: 'suit yourself' }));
    const res = await t.service.searchOrCreateGlobalWord(7, 'suit yourself', undefined, 'Suit yourself, she said');
    expect(res.word.type).toBe('phrasal_verb');
  });

  it('уже фразове дієслово / одне слово → нічого не змінюється', async () => {
    const a = buildService(entry({ type: 'phrasal_verb', text: 'give up' }));
    await a.service.searchOrCreateGlobalWord(7, 'give up', undefined, 'Never give up');
    expect(a.wordRepo.update).not.toHaveBeenCalled();
    const b = buildService(entry({ type: 'word', text: 'house', partOfSpeech: 'noun' }));
    const res = await b.service.searchOrCreateGlobalWord(7, 'house', undefined, 'The house is big');
    expect(res.word.type).toBe('word');
    expect(b.wordRepo.update).not.toHaveBeenCalled();
  });

  it('фраза з пакета карток лишається фразою (інакше зникла б із карток у всіх)', async () => {
    const t = buildService(entry({ packageId: 4 }));
    const res = await t.service.searchOrCreateGlobalWord(7, 'by the way', undefined, 'By the way, he left');
    expect(res.word.type).toBe('phrase');
    expect(t.wordRepo.update).not.toHaveBeenCalled();
  });

  it('збій запису типу не лишає користувача без перекладу', async () => {
    const t = buildService(entry({}));
    t.wordRepo.update.mockRejectedValue(new Error('db'));
    await expect(t.service.searchOrCreateGlobalWord(7, 'by the way', undefined, 'By the way')).resolves.toMatchObject({ transient: false });
  });

  it('читалка передає серверу генерації ознаку reader (вмикає гарантію перекладу)', async () => {
    const t = buildService(entry({ type: 'phrasal_verb' }));
    await t.service.searchOrCreateGlobalWord(7, 'give up', 'verb', 'Never give up');
    expect(t.gen.searchOrCreateGlobalWord).toHaveBeenCalledWith('give up', 'verb', 'Never give up', { reader: true });
  });

  it('новий запис із кількох слів, створений з книги, одразу отримує тип фразового дієслова', () => {
    const { service } = build();
    const structure: any = { normalizedQuery: 'by the way', type: 'fixed_expression' };
    const inReader = (service as any).lookupScope.run({ surface: 'by the way', rawContext: 'By the way, he left', reader: true }, () =>
      (service as any).resolveFinalType(structure, null),
    );
    expect(inReader).toBe('phrasal_verb');
    // Поза книгою (картки, адмінка) — фраза лишається фразою.
    expect((service as any).resolveFinalType(structure, null)).toBe('phrase');
  });
});

describe('3. Форми у відповіді читалки', () => {
  const lookup = async (word: any) => {
    const wordRepo: any = { update: jest.fn(), save: jest.fn(async (w: any) => w) };
    const cache: any = { set: jest.fn(async () => undefined), get: jest.fn(), clear: jest.fn(), clearByPattern: jest.fn() };
    const gen: any = { searchOrCreateGlobalWord: jest.fn(async () => word), analyzeSurfaceInContext: jest.fn(async () => null) };
    const service = new WordService(wordRepo, { findOne: jest.fn(async () => null) } as any, {} as any, {} as any, {} as any, cache, {} as any, gen, {} as any, {} as any);
    for (const l of ['log', 'warn', 'error'] as const) jest.spyOn((service as any).logger, l).mockImplementation(() => undefined);
    return service.searchOrCreateGlobalWord(7, word.text, undefined, `Sentence with ${word.text}`);
  };
  const base = { id: 1, translation: 'x', examples: [], exampleHighlights: [], forms: [] };

  it('неправильне дієслово → форми є', async () => {
    const res = await lookup({ ...base, text: 'go', partOfSpeech: 'verb', type: 'word' });
    expect(res.verbForms).toEqual(['went', 'gone']);
  });

  it('правильне дієслово → форм немає', async () => {
    const res = await lookup({ ...base, text: 'describe', partOfSpeech: 'verb', type: 'word' });
    expect(res.verbForms).toBeNull();
  });

  it('фразове дієслово → форм немає ніколи', async () => {
    const res = await lookup({ ...base, text: 'give up', partOfSpeech: 'phrasal_verb', type: 'phrasal_verb' });
    expect(res.verbForms).toBeNull();
  });

  it('кілька слів із книги (стали фразовим дієсловом) → форм немає', async () => {
    const res = await lookup({ ...base, text: 'take off', partOfSpeech: 'verb', type: 'phrase' });
    expect(res.word.type).toBe('phrasal_verb');
    expect(res.verbForms).toBeNull();
  });
});
