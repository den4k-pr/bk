import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OpenAI } from 'openai/client.js';
import { Word } from './word.entity';
import { createHash } from 'crypto';
import { DurableAiCacheService } from './durable-ai-cache.service';
import {
  buildSafeLemmaCandidates,
  isAmbiguousForm,
  isStandaloneWord,
} from './words-details/lexical-exceptions';
import { analyzeInflections } from './words-details/inflection';

export interface SpellCorrectionResult {
  /** Що реально піде в генератор. */
  query: string;
  /** Оригінал, як його ввів користувач (нормалізований). */
  originalQuery: string;
  /** true — текст було змінено відносно вводу. */
  corrected: boolean;
  /** Чим саме виправлено — для логів і для UI ("Показано результати для…"). */
  method: 'none' | 'normalize' | 'keyboard_layout' | 'common_typo' | 'db_fuzzy' | 'ai';
  /** Якщо збіг знайдено прямо в БД — одразу віддаємо слово, генератор не потрібен. */
  matchedWord?: Word;
  confidence: number;
}


@Injectable()
export class SpellCorrectionService {
  private readonly logger = new Logger(SpellCorrectionService.name);
  private readonly openai: OpenAI;

  /** Максимальна дистанція Левенштейна, яку ще вважаємо "одруком", а не іншим словом. */
  private static readonly MAX_TYPO_DISTANCE = 2;
  /** Мінімальна довжина, щоб узагалі пробувати виправляти. */
  private static readonly MIN_LENGTH_FOR_CORRECTION = 4;
  /** Поріг similarity для pg_trgm. */
  private static readonly TRIGRAM_THRESHOLD = 0.55;

  constructor(
    @InjectRepository(Word) private readonly wordRepo: Repository<Word>,
    // Відповідь ШІ для того самого вводу — з бази, без повторного запиту.
    private readonly aiCache: DurableAiCacheService,
  ) {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  // ─────────────────────────────────────────────────────────────
  // 1. Нормалізація символів
  // ─────────────────────────────────────────────────────────────
  private normalize(raw: string): string {
    return raw
      .trim()
      .toLowerCase()
      // усі варіанти апострофів → прямий ASCII
      .replace(/[’‘`´ʼ]/g, "'")
      // невидимі/нерозривні пробіли
      .replace(/[\u00A0\u200B-\u200D\uFEFF]/g, ' ')
      // подвійні пробіли
      .replace(/\s+/g, ' ')
      // крапки/коми/лапки по краях
      .replace(/^[.,!?;:"«»()\[\]]+|[.,!?;:"«»()\[\]]+$/g, '')
      .trim();
  }

  // 2. Розкладка клавіатури ("фззду" → apple) тут більше НЕ виправляється:
  //    будь-яке українське слово без б/ю/ж/х/ї/є теж дає латиницю
  //    ("машина часу" → "vfibyf xfce"). Кирилицю обробляє
  //    WordGenerationService.resolveUkrainianQuery, яка приймає розкладку
  //    лише якщо таке англійське слово існує.

  // ─────────────────────────────────────────────────────────────
  // 4. Словник частих одруків.
  //    Тримаємо коротким і тільки для випадків, де fuzzy по БД
  //    гарантовано промахнеться (бо правильного слова ще немає в базі).
  // ─────────────────────────────────────────────────────────────
  private static readonly COMMON_TYPOS: Record<string, string> = {
    'recieve': 'receive', 'seperate': 'separate', 'definately': 'definitely',
    'occured': 'occurred', 'neccessary': 'necessary', 'accomodate': 'accommodate',
    'begining': 'beginning', 'beleive': 'believe', 'buisness': 'business',
    'calender': 'calendar', 'cemetary': 'cemetery', 'commited': 'committed',
    'concious': 'conscious', 'embarass': 'embarrass', 'enviroment': 'environment',
    'existance': 'existence', 'foriegn': 'foreign', 'goverment': 'government',
    'grammer': 'grammar', 'independant': 'independent', 'knowlege': 'knowledge',
    'maintainance': 'maintenance', 'occassion': 'occasion', 'perseverence': 'perseverance',
    'priviledge': 'privilege', 'pronounciation': 'pronunciation', 'publically': 'publicly',
    'reccomend': 'recommend', 'refered': 'referred', 'relevent': 'relevant',
    'restaraunt': 'restaurant', 'rythm': 'rhythm', 'succesful': 'successful',
    'tommorow': 'tomorrow', 'untill': 'until', 'wierd': 'weird', 'writen': 'written',
    'thier': 'their', 'freind': 'friend', 'wich': 'which', 'becuase': 'because',
    'alot': 'a lot', 'teh': 'the', 'adress': 'address', 'agressive': 'aggressive',
  };

  // ─────────────────────────────────────────────────────────────
  // Головний метод
  // ─────────────────────────────────────────────────────────────
  async resolve(rawInput: string): Promise<SpellCorrectionResult> {
    const original = this.normalize(rawInput);

    const base = (
      query: string,
      method: SpellCorrectionResult['method'],
      confidence: number,
      matchedWord?: Word,
    ): SpellCorrectionResult => ({
      query,
      originalQuery: original,
      corrected: query !== original,
      method,
      matchedWord,
      confidence,
    });

    if (!original) return base(original, 'none', 1);

    // Кирилиця — український запит (або забута розкладка): ним займається
    // resolveUkrainianQuery, корекція одруків тут не застосовується.
    if (/[а-яіїєґыэъ]/i.test(original)) {
      return base(original, 'none', 1);
    }

    return this.resolveEnglish(original);
  }

  private async resolveEnglish(text: string): Promise<SpellCorrectionResult> {
    const base = (
      query: string,
      method: SpellCorrectionResult['method'],
      confidence: number,
      matchedWord?: Word,
    ): SpellCorrectionResult => ({
      query,
      originalQuery: text,
      corrected: query !== text,
      method,
      matchedWord,
      confidence,
    });

    // ── 3. Точний збіг у БД → помилки немає, виходимо одразу ──
    const exact = await this.findExactInDb(text);
    if (exact) {
      return base(text, 'none', 1, exact);
    }

    // Занадто коротке — виправляти небезпечно ("cat"/"cut"/"cot" —
    // усі валідні, дистанція 1, вгадати неможливо).
    if (text.replace(/\s/g, '').length < SpellCorrectionService.MIN_LENGTH_FOR_CORRECTION) {
      return base(text, 'none', 1);
    }

    // Реальні слова, що лише СХОЖІ на форму іншого (tired/tire, used/use,
    // training/train), — не одруки: далі їх обробляє searchOrCreate.
    if (isStandaloneWord(text) || isAmbiguousForm(text)) {
      return base(text, 'none', 1);
    }

    // ── 4. Словник частих одруків ──
    const known = SpellCorrectionService.COMMON_TYPOS[text];
    if (known) {
      this.logger.log(`📖 Відомий одрук: "${text}" → "${known}"`);
      const w = await this.findExactInDb(known);
      return base(known, 'common_typo', 1, w ?? undefined);
    }

    // ── 5. Граматична форма відомого слова — не одрук ("trained" ≠ "trainer",
    //       "watched" ≠ "watcher"): далі її розбере searchOrCreate.
    if (await this.isInflectionOfKnownWord(text)) {
      return base(text, 'none', 1);
    }

    // ── 6. Fuzzy по власній БД ──
    const fuzzy = await this.findFuzzyInDb(text);
    if (fuzzy) {
      this.logger.log(
        `🔍 Fuzzy-збіг у БД: "${text}" → "${fuzzy.word.text}" (dist=${fuzzy.distance})`,
      );
      return base(fuzzy.word.text, 'db_fuzzy', 0.9, fuzzy.word);
    }

    // ── 7. AI-корекція ──
    const aiFixed = await this.correctViaAi(text);
    if (aiFixed && aiFixed !== text) {
      const w = await this.findExactInDb(aiFixed);
      return base(aiFixed, 'ai', 0.75, w ?? undefined);
    }

    // ── 8. Здаємось — віддаємо як є ──
    return base(text, 'none', 1);
  }

  private async isInflectionOfKnownWord(text: string): Promise<boolean> {
    const lemmas = Array.from(new Set(analyzeInflections(text).map(a => a.lemma)));
    if (lemmas.length === 0) return false;
    const count = await this.wordRepo
      .createQueryBuilder('word')
      .where('LOWER(word.text) IN (:...lemmas)', { lemmas })
      .getCount();
    return count > 0;
  }

  // ─────────────────────────────────────────────────────────────
  private async findExactInDb(text: string): Promise<Word | null> {
    // Спершу точний текст, і лише потім forms: раніше один OR-запит без
    // сортування міг повернути "leave" для "left", навіть коли "left" є в БД.
    const exact = await this.wordRepo
      .createQueryBuilder('word')
      .where('LOWER(word.text) = :text', { text })
      .getOne();
    if (exact) return exact;

    // Для неоднозначних форм збіг у forms — не "точний": значення залежить
    // від контексту, тож рішення лишаємо за searchOrCreate.
    if (isAmbiguousForm(text) || isStandaloneWord(text)) return null;

    return this.wordRepo
      .createQueryBuilder('word')
      .where('word.forms @> ARRAY[CAST(:text AS text)]', { text })
      .orderBy('word.id', 'ASC')
      .getOne();
  }

  /**
   * Кандидати беремо через pg_trgm (індексований, швидкий), а фінальне
   * рішення ухвалює Левенштейн — trigram similarity сама по собі
   * плутає слова з однаковими біграмами ("listen"/"silent" тощо).
   *
   * Потрібне розширення:
   *   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   *   CREATE INDEX word_text_trgm_idx ON word USING gin (text gin_trgm_ops);
   */
  private async findFuzzyInDb(
    text: string,
  ): Promise<{ word: Word; distance: number } | null> {
    let candidates: Word[];

    try {
      candidates = await this.wordRepo
        .createQueryBuilder('word')
        .where('similarity(word.text, :text) > :threshold', {
          text,
          threshold: SpellCorrectionService.TRIGRAM_THRESHOLD,
        })
        .orderBy('similarity(word.text, :text)', 'DESC')
        .setParameter('text', text)
        .limit(10)
        .getMany();
    } catch (error) {
      // pg_trgm не встановлено — деградуємо до префіксного пошуку.
      this.logger.warn('pg_trgm недоступний, fallback на префіксний пошук', error as Error);
      const prefix = text.slice(0, Math.max(3, Math.floor(text.length / 2)));
      candidates = await this.wordRepo
        .createQueryBuilder('word')
        .where('LOWER(word.text) LIKE :p', { p: `${prefix}%` })
        .limit(20)
        .getMany();
    }

    let best: { word: Word; distance: number } | null = null;
    const morphologicalRelatives = new Set(buildSafeLemmaCandidates(text));

    for (const candidate of candidates) {
      // Лема цього ж слова — це не одрук ("walked" → "walk" обробить пошук за лемою).
      if (morphologicalRelatives.has(candidate.text.toLowerCase())) continue;
      // Різна кількість слів — це не одрук.
      if (candidate.text.split(' ').length !== text.split(' ').length) continue;

      const distance = this.levenshtein(text, candidate.text);
      if (distance === 0 || distance > SpellCorrectionService.MAX_TYPO_DISTANCE) continue;

      // Для коротких слів дозволяємо тільки дистанцію 1.
      if (text.length <= 6 && distance > 1) continue;

      if (!best || distance < best.distance) {
        best = { word: candidate, distance };
      }
    }

    return best;
  }

  // ─────────────────────────────────────────────────────────────
  private async correctViaAi(text: string): Promise<string | null> {
    const schema = {
      name: 'spelling_correction',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          isValid: {
            type: 'boolean',
            description: 'true, якщо введений текст — існуюче англійське слово/фраза без помилок',
          },
          corrected: {
            type: 'string',
            description: 'Виправлений варіант. Якщо isValid=true — точна копія вводу.',
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['isValid', 'corrected', 'confidence'],
      },
    };

    const systemPrompt = `Ти коректор орфографії англійської мови. Тобі дають рядок,
який користувач ввів у словниковий застосунок. Твоя задача — визначити,
чи це існуюче англійське слово/фраза, і якщо ні — виправити ОРФОГРАФІЧНУ ПОМИЛКУ.

СУВОРІ ПРАВИЛА:
1. Ти виправляєш ЛИШЕ помилки написання (пропущена/зайва/переставлена/
   неправильна літера). Ти НЕ замінюєш слово на синонім, НЕ перекладаєш,
   НЕ змінюєш граматичну форму (не роби з "apples" → "apple", множина
   це не помилка), НЕ дописуєш і не викидаєш слова з фрази.
2. Виправлення має бути МАКСИМАЛЬНО близьким до вводу: відрізнятись
   не більше ніж на 1-2 літери. Якщо єдиний спосіб отримати осмислене
   слово — змінити більшість літер, це НЕ помилка написання:
   ставь isValid=true і поверни ввід без змін.
3. Якщо ввід — валідне англійське слово (навіть рідкісне, застаріле,
   сленгове, власна назва, абревіатура) — isValid=true, corrected=ввід.
4. Якщо є кілька однаково ймовірних виправлень і жодне не очевидне —
   confidence="low", і краще поверни ввід без змін.
5. Зберігай кількість слів: скільки слів на вході — стільки й на виході.

Приклади:
  "recieve"    → isValid=false, corrected="receive", high
  "aple"       → isValid=false, corrected="apple",   high
  "gve up"     → isValid=false, corrected="give up", high
  "serendipity"→ isValid=true,  corrected="serendipity", high
  "apples"     → isValid=true,  corrected="apples", high   (множина — не помилка)
  "xkqzt"      → isValid=true,  corrected="xkqzt", low     (не відновлюється)

Поверни ЛИШЕ JSON.`;

    type SpellAnswer = { isValid: boolean; corrected: string; confidence: 'high' | 'medium' | 'low' };
    const cacheKey = `v1:spell:${createHash('sha1').update(text.trim().toLowerCase()).digest('hex')}`;

    try {
      let parsed = await this.aiCache.get<SpellAnswer>(cacheKey);
      if (!parsed) {
        const response = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Перевір орфографію: "${text}"` },
          ],
          response_format: { type: 'json_schema', json_schema: schema } as any,
          temperature: 0,
        });

        const content = response.choices[0].message.content;
        if (!content) return null;

        parsed = JSON.parse(content) as SpellAnswer;
        await this.aiCache.set(cacheKey, 'spell', parsed);
      }

      if (parsed.isValid) return null;
      if (parsed.confidence === 'low') {
        this.logger.log(`🤖 AI не впевнений у виправленні "${text}" — залишаю як є.`);
        return null;
      }

      const candidate = parsed.corrected.trim().toLowerCase();

      // ⚠️ ГОЛОВНИЙ ЗАПОБІЖНИК: навіть зі strict-схемою і прямою забороною
      // в промпті модель регулярно "виправляє" рідкісне слово на популярне
      // (serendipity → serenity). Довіряти самому лише промпту не можна —
      // перевіряємо результат кодом.
      if (!/^[a-z]+(?:[ '-][a-z]+)*$/.test(candidate)) return null;
      if (candidate.split(' ').length !== text.split(' ').length) return null;

      const distance = this.levenshtein(text, candidate);
      if (distance === 0) return null;
      if (distance > SpellCorrectionService.MAX_TYPO_DISTANCE) {
        this.logger.warn(
          `⚠️ AI запропонував "${candidate}" для "${text}" (dist=${distance}) — ` +
          `це підміна слова, а не виправлення одруку. Відхилено.`,
        );
        return null;
      }

      this.logger.log(`🤖 AI виправив: "${text}" → "${candidate}" (dist=${distance})`);
      return candidate;
    } catch (error) {
      // Корекція — необовʼязковий крок. Якщо AI недоступний,
      // просто пропускаємо його і йдемо далі з оригіналом.
      this.logger.warn(`Корекція через AI провалилась для "${text}"`, error as Error);
      return null;
    }
  }

  private levenshtein(a: string, b: string): number {
    const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
      new Array(b.length + 1).fill(0),
    );
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp[a.length][b.length];
  }
}