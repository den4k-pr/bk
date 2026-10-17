import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { OpenAI } from 'openai/client.js';
import { Word, PartOfSpeech } from '../word.entity';
import { CacheService } from 'src/cache/cache.service';
import { DurableAiCacheService } from '../durable-ai-cache.service';
import { SingleFlight } from 'src/common/utils/single-flight';
import {
  classifyQueryStructure,
  StructureClassification,
} from './phrase-structure-classifier';
import { computeDegreeForms } from './degree-forms';
import { PhraseLibrary } from 'src/phrase-library/phrase-library.entity';
import {
  CONJUNCTIONS,
  DETERMINERS,
  PREPOSITIONS,
  PRONOUNS,
  classifyClosedClassWord,
  classifyNumeralWord,
} from './english-lexicons';

/** Слова, у яких "'s" — скорочення is/has, а не присвійна форма. */
const NON_POSSESSIVE_S = new Set(['there', 'here', 'where', 'how', 'let', 'what', 'who', 'that', 'it', 'he', 'she']);

/** Службове слово, що належить до кількох закритих класів (but, for, that, his…). */
function isMultiClassFunctionWord(word: string): boolean {
  const w = word.toLowerCase().trim();
  return [PREPOSITIONS, CONJUNCTIONS, PRONOUNS, DETERMINERS].filter(set => set.has(w)).length > 1;
}
import {
  AMBIGUOUS_FORMS,
  buildSafeLemmaCandidates,
  isAmbiguousForm,
  isStandaloneWord,
} from './lexical-exceptions';
import {
  INFLECTION_KIND_LABEL_UK,
  InflectionAnalysis,
  analyzeInflections,
  inflectionKindOf,
  lemmaPosOf,
  posClassOf,
} from './inflection';
import { contextCue } from './context-cues';
import {
  ResolutionPlan,
  SenseOption,
  isIngForm,
  planResolution,
} from './word-sense-resolution';
import { WordSurfaceAlias } from '../word-surface-alias.entity';
import { resolveEntryType } from './entry-type';
import {
  MAX_EXAMPLE_LENGTH,
  isWithinExampleLimit,
  enforceExampleArrayConstraints,
} from './example-length.util';
import {
  hasCyrillic,
  isLatinQuery,
  validateGeneratedEntry,
  validateUkrainianTranslation,
} from './generated-entry-validation';
import { isKnownVerbLemma } from './english-verb-lexicon';
import { uaLayoutToEnglish } from './keyboard-layout';
import { normalizeLookupQuery } from './reader-lookup.util';
import { toNeutralReflexivePhrase } from './reflexive-phrase.util';

// Прибирає хвостову крапку (і пробіли) — AI періодично додає її до
// транскрипції/прикладів, а клієнт чекає чистих значень.
const stripTrailingPeriod = (value: string): string => value.replace(/\.\s*$/, '');

type WordType = 'word' | 'phrase' | 'phrasal_verb';

interface CreativeContent {
  translation: string;
  pronunciation: string;
  examples: string[];
  level: string;
  partOfSpeech?: string;
  text?: string;
  isProperNoun?: boolean;
  /** Модель підтверджує, що це справжнє англійське слово / вираз. */
  isRealEnglishEntry?: boolean;
}

interface CanonicalFormOverride {
  lemma: string;
  partOfSpeech: PartOfSpeech;
}

class DuplicateLemmaFoundError extends Error {
  constructor(public readonly word: Word) {
    super(`Lemma "${word.text}" already exists in DB`);
  }
}

/**
 * AI-контент не пройшов перевірку (validateGeneratedEntry): у БД нічого не
 * пишемо. Користувач замість помилки отримує переклад без збереження
 * (buildTransientWord).
 */
export class GenerationRejectedError extends Error {
  constructor(public readonly query: string, public readonly reasons: string[]) {
    super(`Generation for "${query}" rejected: ${reasons.join(', ')}`);
  }
}

/** Граматичний розбір натиснутої форми в реченні + її переклад саме тут. */
export interface SurfaceAnalysis {
  surface: string;
  verbGroup: string | null;
  function: string;
  tense: string;
  person: string;
  number: string;
  ukAspect: string;
  contextualTranslation: string;
  lemmaSenseInContext: string;
  confidence: 'high' | 'medium';
  /**
   * Натиснуте слово — лише допоміжне в групі ("had" у "had imagined"):
   * contextualTranslation тоді перекладає ВСЮ групу, а не це слово.
   */
  isAuxiliary?: boolean;
}

/** Англійський запит, отриманий з українського вводу. */
export interface UkrainianQueryResolution {
  english: string;
  method: 'db_translation' | 'keyboard_layout' | 'ai';
  matchedWord?: Word;
}

export interface BulkWordPreviewItem {
  inputText: string;
  status: 'generated' | 'duplicate' | 'error';
  errorMessage?: string;
  existingWordId?: number;
  data: {
    text: string;
    translation: string;
    pronunciation: string;
    type: WordType;
    partOfSpeech: string | null;
    examples: string[];
    level: string | null;
    forms: string[];
    description: string;
    definitions: string[];
    packageId: number | null;
    isProperNoun: boolean;
  };
}

@Injectable()
export class WordGenerationService {
  private readonly logger = new Logger(WordGenerationService.name);
  private static readonly ALL_WORDS_CACHE_KEY = 'v1:words:all2';
  private static readonly ALL_WORDS_SHORT_CACHE_KEY = 'v1:words:all2:short';

  private static readonly MAX_CONTENT_GENERATION_ATTEMPTS = 2;

  // 🔒 Жорсткий ліміт довжини прикладу речення (символів, включно з
  // пробілами та розділовими знаками). Реальне забезпечення ліміту —
  // через enforceExampleArrayConstraints() у requestCreativeContentWithRetry,
  // а не лише через опис у JSON-схемі (див. example-length.util.ts).
  private static readonly MAX_EXAMPLE_LENGTH = MAX_EXAMPLE_LENGTH;

  private static readonly CANONICAL_FORM_OVERRIDES: Record<string, CanonicalFormOverride> = {
    "didn't": { lemma: "did not", partOfSpeech: "verb" },
    "don't": { lemma: "do not", partOfSpeech: "verb" },
    "doesn't": { lemma: "does not", partOfSpeech: "verb" },
    "isn't": { lemma: "is not", partOfSpeech: "verb" },
    "aren't": { lemma: "are not", partOfSpeech: "verb" },
    "wasn't": { lemma: "was not", partOfSpeech: "verb" },
    "weren't": { lemma: "were not", partOfSpeech: "verb" },
    "won't": { lemma: "will not", partOfSpeech: "verb" },
    "can't": { lemma: "cannot", partOfSpeech: "verb" },
    "couldn't": { lemma: "could not", partOfSpeech: "verb" },
    "shouldn't": { lemma: "should not", partOfSpeech: "verb" },
    "wouldn't": { lemma: "would not", partOfSpeech: "verb" },
    "hasn't": { lemma: "has not", partOfSpeech: "verb" },
    "haven't": { lemma: "have not", partOfSpeech: "verb" },
    "hadn't": { lemma: "had not", partOfSpeech: "verb" },
    "mustn't": { lemma: "must not", partOfSpeech: "verb" }
  };

  private static openAiQuotaBlockedUntil: number | null = null;
  // До якого часу діє пауза саме через "немає коштів" на рахунку OpenAI —
  // єдина причина (крім падіння сервера), з якої тап у книзі може лишитись
  // без перекладу нового слова.
  private static openAiOutOfFundsUntil: number | null = null;
  // "Немає коштів" (insufficient_quota): пауза коротка — після поповнення
  // рахунку генерація має відновитись за хвилину, а не за 5.
  private static readonly QUOTA_COOLDOWN_MS = 60 * 1000;
  // "Забагато запитів за хвилину" (rate limit): чекаємо стільки, скільки
  // просить OpenAI (retry-after), але в цих межах.
  private static readonly RATE_LIMIT_DEFAULT_COOLDOWN_MS = 5 * 1000;
  private static readonly RATE_LIMIT_MAX_COOLDOWN_MS = 30 * 1000;

  private static readonly MAX_BULK_WORDS = 50;
  private static readonly BULK_GENERATION_CONCURRENCY = 5;

  private readonly openai: OpenAI;

  /**
   * ⚡ Однакові одночасні запити (подвійний тап, автоповтор клієнта, двоє
   * користувачів на тому самому новому слові в тому самому реченні) чекають
   * один ланцюжок AI замість запуску другого такого ж. Логіка пошуку /
   * генерації не змінюється — лише не дублюється.
   */
  private readonly lookupFlight = new SingleFlight();
  private readonly surfaceAnalysisFlight = new SingleFlight();

  /**
   * ⚡ Тап у читалці: яку форму натиснули і в якому реченні. Потрібно, щоб
   * під час генерації НОВОГО слова почати контекстний розбір форми ("made"
   * у цьому реченні) одразу, як модель видала переклад леми, — паралельно з
   * генерацією прикладів, а не після неї. Поза тапом (адмінка, пошук) — порожньо.
   */
  private readonly lookupScope = new AsyncLocalStorage<{ surface: string; rawContext?: string; reader?: boolean }>();
  /**
   * Розбори форми, запущені наперед (див. startSurfacePrefetch). Ключ — РІВНО
   * ті вхідні дані, з якими розбір пішов би звичайним шляхом (лема, частина
   * мови, переклад леми, форма, речення): готовий результат використовується
   * лише при повному збігу, інакше — звичайний розбір.
   */
  private readonly surfacePrefetches = new Map<string, Promise<FormTranslationOutcome>>();
  private static readonly SURFACE_PREFETCH_TTL_MS = 60_000;

  constructor(
    private readonly cacheService: CacheService,
    @InjectRepository(Word) private wordRepo: Repository<Word>,
    @InjectRepository(PhraseLibrary) private phraseLibraryRepo: Repository<PhraseLibrary>,
    @InjectRepository(WordSurfaceAlias) private aliasRepo: Repository<WordSurfaceAlias>,
    // Відповіді ШІ, що залежать лише від входу (слово + речення, запит), —
    // у БД назавжди: той самий запит у OpenAI вдруге не йде.
    private readonly aiCache: DurableAiCacheService,
  ) {
    // Без власного таймауту запит до OpenAI може висіти до 10 хв (типове
    // значення SDK), а читалка чекає відповідь на тап.
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: WordGenerationService.OPENAI_TIMEOUT_MS,
      maxRetries: 1,
    });
  }

  /**
   * Модель для вибору значення слова за реченням. Задача вузька (обрати
   * один із 2–4 варіантів), тому достатньо дешевої моделі; рішення
   * кешується на 30 днів для пари (слово, речення).
   */
  private static readonly CONTEXT_MODEL = process.env.WORD_CONTEXT_MODEL || 'gpt-4o-mini';

  /**
   * Пошук наявного слова в БД за пріоритетом (раніше був один OR-запит
   * без сортування, тож "training" могло повернути "train"):
   *   1. точний збіг тексту;
   *   2. кириличний запит — пошук за перекладом;
   *   3. "самостійні" слова (news, during, interesting…) — лише точний збіг;
   *   4. збіг серед forms (went → go) та безпечні кандидати-леми;
   *   5. неоднозначні форми (training, left, tired…) — за контекстом речення
   *      (AI, з кешем); без контексту — саме слово, а не лема.
   *
   * keepSurface = true: якщо слова немає, генерувати запис саме для цієї
   * форми, не дозволяючи AI звести її до іншої леми.
   */
  private async findExistingWord(
    lowerQuery: string,
    context?: string,
  ): Promise<{ word: Word | null; keepSurface: boolean }> {
    const exact = await this.wordRepo
      .createQueryBuilder('word')
      .where('LOWER(word.text) = :q', { q: lowerQuery })
      .orderBy('word.id', 'ASC')
      .getOne();
    if (exact) return { word: exact, keepSurface: false };

    if (/[а-яіїєґ]/i.test(lowerQuery)) {
      const byTranslation = await this.wordRepo
        .createQueryBuilder('word')
        .where('LOWER(word.translation) LIKE :like', { like: `%${lowerQuery}%` })
        .orderBy('CASE WHEN LOWER(word.translation) = :q THEN 0 ELSE 1 END', 'ASC')
        .addOrderBy('LENGTH(word.translation)', 'ASC')
        .setParameter('q', lowerQuery)
        .getOne();
      return { word: byTranslation ?? null, keepSurface: false };
    }

    if (isStandaloneWord(lowerQuery)) {
      return { word: null, keepSurface: true };
    }

    const byForms = await this.wordRepo
      .createQueryBuilder('word')
      .where('word.forms @> ARRAY[CAST(:q AS text)]', { q: lowerQuery })
      .orderBy('word.id', 'ASC')
      .limit(5)
      .getMany();

    const lemmaCandidates = buildSafeLemmaCandidates(lowerQuery);
    const byLemma = lemmaCandidates.length
      ? await this.wordRepo
          .createQueryBuilder('word')
          .where('LOWER(word.text) IN (:...candidates)', { candidates: lemmaCandidates })
          .getMany()
      : [];
    byLemma.sort(
      (a, b) =>
        lemmaCandidates.indexOf(a.text.toLowerCase()) - lemmaCandidates.indexOf(b.text.toLowerCase()),
    );

    const ordered: Word[] = [];
    for (const w of [...byForms, ...byLemma]) {
      if (!ordered.some(o => o.id === w.id)) ordered.push(w);
    }

    const ambiguous = isAmbiguousForm(lowerQuery);

    if (ordered.length === 0) {
      // Нічого не знайдено: неоднозначну форму без контексту генеруємо як є
      // ("training" → "training"); з контекстом лему обере AI за реченням.
      return { word: null, keepSurface: ambiguous && !context };
    }

    if (!ambiguous) return { word: ordered[0], keepSurface: false };
    if (!context) return { word: null, keepSurface: true };

    const choice = await this.chooseUsageInContext(lowerQuery, ordered, context);
    if (choice) return { word: choice, keepSurface: false };
    return { word: null, keepSurface: true };
  }

  /**
   * Для неоднозначної форми вирішує за реченням: це форма одного з
   * кандидатів ("She is training" → train) чи окреме слово ("The training
   * was hard" → training). Рішення кешується на 30 днів за парою
   * (слово, речення). Якщо AI недоступний — як раніше, повертаємо лему.
   */
  private async chooseUsageInContext(
    surface: string,
    candidates: Word[],
    context: string,
  ): Promise<Word | null> {
    const SEPARATE = '__separate_word__';
    const options = candidates.map(c => c.text.toLowerCase());
    const hash = createHash('sha1')
      .update(`${surface}|${options.join(',')}|${context.toLowerCase()}`)
      .digest('hex');
    const cacheKey = `v1:word-usage:${hash}`;

    let decision = (await this.aiCache.get<string>(cacheKey)) ?? undefined;

    if (!decision) {
      try {
        this.assertOpenAiAvailable();
        const response = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                'Ти лінгвіст. Визнач, як ужито англійське слово в реченні. ' +
                'Якщо тут воно — граматична форма одного з кандидатів-лем (час, особа, множина, ' +
                'дієприкметник у складі дієслівної форми) — поверни цей кандидат. ' +
                `Якщо тут воно — окреме слово зі своїм словниковим значенням (віддієслівний іменник, ` +
                `прикметник, слово-омонім) — поверни "${SEPARATE}". ` +
                `Приклади: "She is training for a race" + [train] → train; "The training was hard" + [train] → ${SEPARATE}; ` +
                `"Turn left" + [leave] → ${SEPARATE}; "He left early" + [leave] → leave; "I am tired" + [tire] → ${SEPARATE}.`,
            },
            {
              role: 'user',
              content: `Слово: "${surface}"\nКандидати-леми: ${options.join(', ')}\nРечення: «${context}»`,
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'word_usage',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: { choice: { type: 'string', enum: [...options, SEPARATE] } },
                required: ['choice'],
              },
            },
          } as any,
        });
        const content = response.choices[0]?.message?.content;
        decision = content ? (JSON.parse(content).choice as string) : undefined;
        if (decision) await this.aiCache.set(cacheKey, 'word-usage', decision);
      } catch (error) {
        this.logger.warn(
          `Не вдалося визначити вживання "${surface}" за контекстом: ${(error as Error)?.message}`,
        );
        return candidates[0];
      }
    }

    if (!decision || decision === SEPARATE) return null;
    return candidates.find(c => c.text.toLowerCase() === decision) ?? null;
  }

  /** Обмежує й очищає речення-контекст, що прийшло від клієнта. */
  private sanitizeContext(context?: string): string | undefined {
    if (typeof context !== 'string') return undefined;
    const clean = context.replace(/[\u0000-\u001f«»]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length < 3) return undefined;
    return clean.slice(0, 400);
  }

  private assertOpenAiAvailable(): void {
    const until = WordGenerationService.openAiQuotaBlockedUntil;
    if (until && Date.now() < until) {
      const secondsLeft = Math.ceil((until - Date.now()) / 1000);
      throw new ServiceUnavailableException(
        `Сервіс генерації слів тимчасово недоступний (вичерпано ліміт AI). Спробуйте приблизно через ${secondsLeft}с.`,
      );
    }
  }

  private static readonly OPENAI_TIMEOUT_MS = 30_000;
  /**
   * Скільки тап у читалці чекає на створення ДОДАТКОВОГО значення слова,
   * яке вже є в словнику. Довше — показуємо наявний запис, а нове значення
   * дозберігається у фоні.
   */
  private static readonly NEW_SENSE_BUDGET_MS = 9_000;

  /** Модель для розбору форми в реченні; результат кешується на 30 днів для кожного речення. */
  private static readonly SURFACE_ANALYSIS_MODEL = process.env.SURFACE_ANALYSIS_MODEL || 'gpt-4o';

  /**
   * «Достовірний переклад» натиснутої ФОРМИ слова ("climbed" → "піднявся"),
   * окремо від перекладу леми ("climb" — "підніматися").
   *
   * Просте правило (вимога власника):
   *  - перекладається ЛИШЕ саме слово-форма — без дієслівної групи
   *    ("had just climbed") і без речення;
   *  - генерується ОДИН раз на форму і зберігається в записі слова
   *    (word.surfaceTranslations) — у будь-якому іншому реченні та сама форма
   *    береться з бази, без запиту до AI;
   *  - раніше збережені переклади форм (v2) використовуються як є.
   * Речення (rawContext) більше не впливає на результат — параметр лишився
   * для сумісності викликів. Для самої леми окремого перекладу немає.
   */
  async analyzeSurfaceInContext(word: Word, surface: string, _rawContext?: string): Promise<SurfaceAnalysis | null> {
    if (!word?.id || (word as Word & { transient?: boolean }).transient) return null;
    const key = (surface ?? '').toLowerCase().trim();
    const lemma = (word.text ?? '').toLowerCase();
    if (!key || !/^[a-z][a-z'-]*$/.test(key) || key === lemma) return null;

    const stored = this.storedFormTranslation(word.surfaceTranslations, key);
    if (stored) return this.minimalAnalysis(key, stored);

    return this.surfaceAnalysisFlight.run(`${word.id}|${key}`, () => this.createFormTranslation(word, key));
  }

  private storedFormTranslation(map: Record<string, string> | null | undefined, key: string): string | null {
    const value = map?.[`v3|${key}`] ?? map?.[`v2|${key}`];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private async createFormTranslation(word: Word, key: string): Promise<SurfaceAnalysis | null> {
    // Інший запит міг зберегти переклад, поки цей чекав у черзі.
    const fresh = await this.wordRepo
      .findOne({ where: { id: word.id }, select: { id: true, surfaceTranslations: true } })
      .catch(() => null);
    const already = this.storedFormTranslation(fresh?.surfaceTranslations, key);
    if (already) return this.minimalAnalysis(key, already);

    // Для щойно згенерованого слова переклад форми міг стартувати ще під
    // час генерації картки — з тими самими вхідними даними.
    const prefetched = this.takeSurfacePrefetch(word, key);
    const outcome = prefetched ? await prefetched : await this.computeFormTranslation(word, key);
    if (!outcome.ok || !outcome.translation) return null;

    const storageKey = `v3|${key}`;
    try {
      // Атомарне доповнення jsonb: не перезаписує переклади інших форм.
      await this.wordRepo.query(
        `UPDATE "word" SET "surfaceTranslations" = COALESCE("surfaceTranslations", '{}'::jsonb) || $1::jsonb WHERE id = $2`,
        [JSON.stringify({ [storageKey]: outcome.translation }), word.id],
      );
    } catch (error) {
      this.logger.warn(`Не вдалося зберегти переклад форми "${key}": ${(error as Error)?.message}`);
    }
    word.surfaceTranslations = { ...(word.surfaceTranslations ?? {}), [storageKey]: outcome.translation };
    this.logger.log(`🔤 "${key}" (${word.text}) → "${outcome.translation}" — збережено для всіх речень`);
    return this.minimalAnalysis(key, outcome.translation);
  }

  /**
   * Один короткий запит: дослівний переклад самої форми. До 2 спроб з
   * перевіркою (українські літери, коротко). ok: false — помилка виклику AI.
   * З word беруться лише text, partOfSpeech і translation.
   */
  private async computeFormTranslation(
    word: Pick<Word, 'text' | 'partOfSpeech' | 'translation'>,
    key: string,
  ): Promise<FormTranslationOutcome> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        this.assertOpenAiAvailable();
        const raw = await this.requestFormTranslation(word, key);
        const translation = String(raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
        const problems = formTranslationProblems(translation);
        if (problems.length === 0) return { ok: true, translation };
        this.logger.warn(`⚠️ Переклад форми "${key}" (спроба ${attempt}) відхилено: ${problems.join(', ')} — "${translation}"`);
      } catch (error) {
        this.logger.warn(`Не вдалося перекласти форму "${key}": ${(error as Error)?.message}`);
        return { ok: false };
      }
    }
    return { ok: true, translation: null };
  }

  private async requestFormTranslation(
    word: Pick<Word, 'text' | 'partOfSpeech' | 'translation'>,
    key: string,
  ): Promise<string | null> {
    const response = await this.openai.chat.completions.create({
      model: WordGenerationService.SURFACE_ANALYSIS_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: [
            'You are an English-Ukrainian dictionary. Translate ONE English word FORM into Ukrainian literally,',
            'keeping its grammatical form (tense, person, number, degree). Translate only this single word:',
            'no subject, no auxiliaries, no other words of any sentence.',
            'Rules:',
            '- Use the sense of the dictionary form given as reference.',
            '- Past tense / past participle -> Ukrainian past tense, masculine singular: climbed -> піднявся; went -> пішов; made -> зробив.',
            '- 3rd person singular -> goes -> йде; makes -> робить.',
            '- -ing form -> дієприслівник or verbal noun: running -> біжучи / біг; reading -> читаючи / читання.',
            '- Plural noun -> plural: children -> діти; houses -> будинки.',
            '- Comparative / superlative -> better -> кращий; biggest -> найбільший.',
            '- Never return the infinitive for a past or 3rd-person form.',
            '- 1 variant, or 2 variants separated by " / "; each variant 1-2 words. Ukrainian letters only, no explanations.',
          ].join('\n'),
        },
        {
          role: 'user',
          content:
            `Form: "${key}"\n` +
            `Dictionary form: "${word.text}" (${word.partOfSpeech ?? 'part of speech unknown'}) — "${word.translation}"`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'form_translation_v1',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['translation'],
            properties: { translation: { type: 'string' } },
          },
        },
      } as any,
    });
    const content = response.choices[0]?.message?.content;
    return content ? (JSON.parse(content).translation as string) : null;
  }

  private surfacePrefetchKey(word: Pick<Word, 'text' | 'partOfSpeech' | 'translation'>, key: string): string {
    return JSON.stringify([word.text, word.partOfSpeech ?? null, word.translation, key]);
  }

  private takeSurfacePrefetch(word: Word, key: string): Promise<FormTranslationOutcome> | undefined {
    const prefetchKey = this.surfacePrefetchKey(word, key);
    const pending = this.surfacePrefetches.get(prefetchKey);
    if (pending) this.surfacePrefetches.delete(prefetchKey);
    return pending;
  }

  /**
   * ⚡ Запускає переклад форми наперед — щойно під час генерації НОВОГО слова
   * модель видала переклад леми. Ті самі умови, що й в analyzeSurfaceInContext:
   * якщо там AI не викликався б, тут теж нічого не стартує.
   */
  private startSurfacePrefetch(word: Pick<Word, 'text' | 'partOfSpeech' | 'translation'>): void {
    const scope = this.lookupScope.getStore();
    if (!scope) return;
    const key = (scope.surface ?? '').toLowerCase().trim();
    const lemma = word.text.toLowerCase();
    if (!key || !/^[a-z][a-z'-]*$/.test(key) || key === lemma) return;

    const prefetchKey = this.surfacePrefetchKey(word, key);
    if (this.surfacePrefetches.has(prefetchKey)) return;

    const pending = this.computeFormTranslation(word, key).catch((): FormTranslationOutcome => ({ ok: false }));
    this.surfacePrefetches.set(prefetchKey, pending);
    // Не використаний результат (слово не пройшло перевірку тощо) не лежить вічно.
    const timer = setTimeout(() => {
      if (this.surfacePrefetches.get(prefetchKey) === pending) this.surfacePrefetches.delete(prefetchKey);
    }, WordGenerationService.SURFACE_PREFETCH_TTL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  private minimalAnalysis(surface: string, translation: string): SurfaceAnalysis {
    return {
      surface,
      verbGroup: null,
      function: 'other',
      tense: 'none',
      person: 'none',
      number: 'none',
      ukAspect: 'none',
      contextualTranslation: translation,
      lemmaSenseInContext: translation,
      confidence: 'medium',
    };
  }

  /** Скільки секунд просить зачекати OpenAI (заголовки retry-after / retry-after-ms). */
  private static retryAfterMs(error: any): number | null {
    const headers = error?.headers;
    const read = (name: string): string | null => {
      if (!headers) return null;
      if (typeof headers.get === 'function') return headers.get(name);
      return headers[name] ?? null;
    };
    const ms = Number(read('retry-after-ms'));
    if (Number.isFinite(ms) && ms > 0) return ms;
    const seconds = Number(read('retry-after'));
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    return null;
  }

  private handleOpenAiError(error: any, context: string): never {
    const code: string | undefined = error?.code ?? error?.error?.code ?? undefined;
    const type: string | undefined = error?.type ?? error?.error?.type ?? undefined;
    const openAiMessage: string = String(error?.error?.message ?? error?.message ?? '').slice(0, 300);

    // 429 буває двох різних видів, і раніше обидва вимикали ШІ на 5 хв:
    //  - insufficient_quota — на рахунку OpenAI немає коштів / вичерпано
    //    бюджет проєкту → пауза QUOTA_COOLDOWN_MS;
    //  - rate_limit_exceeded (і будь-яка інша 429) — забагато запитів за
    //    хвилину → пауза рівно на retry-after (кілька секунд).
    const isQuota = code === 'insufficient_quota' || type === 'insufficient_quota';
    const isRateLimit = !isQuota && error?.status === 429;

    if (isQuota || isRateLimit) {
      const cooldownMs = isQuota
        ? WordGenerationService.QUOTA_COOLDOWN_MS
        : Math.min(
            WordGenerationService.RATE_LIMIT_MAX_COOLDOWN_MS,
            WordGenerationService.retryAfterMs(error) ?? WordGenerationService.RATE_LIMIT_DEFAULT_COOLDOWN_MS,
          );
      const blockedUntil = Date.now() + cooldownMs;
      if (isQuota) WordGenerationService.openAiOutOfFundsUntil = blockedUntil;
      // Не продовжуємо вже довшу паузу коротшою.
      WordGenerationService.openAiQuotaBlockedUntil = Math.max(
        WordGenerationService.openAiQuotaBlockedUntil ?? 0,
        blockedUntil,
      );
      // Справжня відповідь OpenAI в логах — щоб було видно, що саме не так
      // (немає коштів, ліміт проєкту, ліміт запитів за хвилину…).
      this.logger.error(
        `🚫 OpenAI 429 [${isQuota ? 'НЕМАЄ КОШТІВ / бюджет вичерпано' : 'ліміт запитів за хвилину'}] ` +
          `(${context}) code=${code ?? '-'} type=${type ?? '-'}: "${openAiMessage}". ` +
          `Пауза ШІ ${Math.round(cooldownMs / 1000)}с.`,
      );
      throw new ServiceUnavailableException(
        isQuota
          ? 'Сервіс генерації слів тимчасово недоступний (вичерпано ліміт AI). Спробуйте пізніше.'
          : 'Сервіс генерації слів перевантажений. Спробуйте за кілька секунд.',
      );
    }

    this.logger.error(`Помилка OpenAI (${context}):`, error as Error);
    throw new InternalServerErrorException('Не вдалося виконати запит через AI');
  }

  /** Остання перевірка перед записом у глобальний словник. */
  private entryProblems(entry: Partial<Word>, creative: CreativeContent): string[] {
    return validateGeneratedEntry({
      text: entry.text ?? '',
      translation: entry.translation ?? '',
      pronunciation: entry.pronunciation,
      examples: entry.examples,
      isProperNoun: entry.isProperNoun,
      isRealEnglishEntry: creative.isRealEnglishEntry,
    });
  }

  private assertEntryValid(entry: Partial<Word>, creative: CreativeContent): void {
    const reasons = this.blockingProblems(entry, this.entryProblems(entry, creative));
    if (reasons.length > 0) {
      throw new GenerationRejectedError(entry.text ?? '', reasons);
    }
  }

  /**
   * Які з проблем справді не дають зберегти запис.
   *  - Приклади й вимова ніколи не блокують: їх ремонтує repairEntryFields
   *    (лишаються лише коректні пари / вимова кирилицею, або порожньо —
   *    застосунок тоді їх просто не показує).
   *  - Тап у книзі (є речення): слово існує в тексті, тож перевірки "чи це
   *    слово" (латиниця в text, без голосних, відповідь моделі "не слово") не
   *    блокують; латиниця в перекладі, де є й українські літери, — теж.
   *  - Блокує лише переклад, якого немає взагалі (і після ремонту), та
   *    сміттєвий ручний ввід поза книгою — як і раніше.
   */
  private blockingProblems(entry: Partial<Word>, reasons: string[]): string[] {
    const reader = !!this.readerTap();
    const hasUkrainian = /[а-щьюяєіїґ]/i.test(entry.translation ?? '');
    return reasons.filter(reason => {
      if (reason === 'pronunciation_latin' || reason.startsWith('example')) return false;
      if (!reader) return true;
      if (reason === 'text_not_latin' || reason === 'text_no_vowel' || reason === 'model_not_real_entry') return false;
      // Переклад українською є (repairTranslation це гарантує) — формальні
      // зауваження (латинська назва всередині, "невідомий" як справжній
      // переклад, довжина) не блокують.
      if (reason.startsWith('translation_')) return !hasUkrainian;
      return true;
    });
  }

  /**
   * Перед збереженням НОВОГО запису: поля, що не пройшли перевірку,
   * ремонтуються, а не відкидають усе слово (раніше, наприклад, вимова
   * латиницею "dɪˈskraɪb" для "describe" = користувач не бачив нічого).
   * Коректний запис не змінюється і жодних додаткових запитів не робить.
   */
  private async prepareEntryForSave(entry: Word, creative: CreativeContent): Promise<void> {
    const reasons = this.entryProblems(entry, creative);
    if (reasons.length > 0) await this.repairEntryFields(entry, reasons);
    this.assertEntryValid(entry, creative);
  }

  private async repairEntryFields(entry: Word, reasons: string[]): Promise<void> {
    const text = (entry.text ?? '').trim();
    if (reasons.includes('pronunciation_latin')) {
      const before = entry.pronunciation;
      entry.pronunciation = await this.repairPronunciation(text, entry.pronunciation ?? '');
      this.logger.warn(`🩹 "${text}": вимова "${before}" (латиниця) → "${entry.pronunciation}"`);
    }
    if (reasons.some(r => r.startsWith('example'))) {
      entry.examples = await this.repairExamples(entry);
      this.logger.warn(`🩹 "${text}": приклади відремонтовано (${entry.examples.length / 2} пар)`);
    }
    if (reasons.some(r => r.startsWith('translation_'))) {
      const before = entry.translation;
      entry.translation = await this.repairTranslation(text, entry.translation ?? '');
      this.logger.warn(`🩹 "${text}": переклад "${before}" → "${entry.translation}"`);
    }
  }

  /** Вимова кирилицею: спершу без AI (прибрати латинські вставки), інакше — короткий запит. "" — не вдалося. */
  private async repairPronunciation(text: string, current: string): Promise<string> {
    const LATIN = /[a-z\u0250-\u02af\u02b0-\u02ffæðŋθʃʒ]/i;
    const cyrillicOnly = current
      .replace(/\([^)]*\)|\[[^\]]*\]|\/[^/]*\//g, ' ')
      .split(/\s+/)
      .filter(token => token && !LATIN.test(token))
      .join(' ')
      .replace(/[^а-щьюяєіїґ\s-]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (/[а-щьюяєіїґ]/i.test(cyrillicOnly)) return cyrillicOnly;
    if (!text) return '';

    // Без кешу за текстом слова: слово, видалене з бази, має генеруватись
    // повністю заново, а не збиратись зі збережених раніше шматків.
    try {
      this.assertOpenAiAvailable();
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Ти укладаєш англо-український словник. Запиши, як ЗВУЧИТЬ англійське слово чи фраза, українськими ' +
              'літерами (фонологічна транслітерація). Лише літери українського алфавіту та пробіли: без латиниці, ' +
              'дужок, апострофів, наголосів і спецсимволів. Твердий /g/ — "ґ", /h/ — "г". ' +
              'Приклади: apple → епл, necktie → нектай, get → ґет, garden → ґарден.',
          },
          { role: 'user', content: `"${text}"` },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'pronunciation_cyrillic_v1',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['pronunciation'],
              properties: { pronunciation: { type: 'string' } },
            },
          },
        } as any,
      });
      const raw = response.choices[0]?.message?.content;
      const value = raw ? String(JSON.parse(raw).pronunciation ?? '').replace(/\s+/g, ' ').trim() : '';
      if (value && /[а-щьюяєіїґ]/i.test(value) && !LATIN.test(value)) {
        return value;
      }
    } catch (error) {
      this.logger.warn(`Ремонт вимови "${text}" не вдався: ${(error as Error)?.message}`);
    }
    return '';
  }

  /** Лише коректні пари [англ, укр]; якщо жодної — короткий запит на 2 пари; інакше []. */
  private async repairExamples(entry: Word): Promise<string[]> {
    const validPairs = (list: unknown): string[] => {
      const items = Array.isArray(list) ? list : [];
      const out: string[] = [];
      for (let i = 0; i + 1 < items.length; i += 2) {
        const en = typeof items[i] === 'string' ? stripTrailingPeriod(items[i].trim()) : '';
        const uk = typeof items[i + 1] === 'string' ? stripTrailingPeriod(items[i + 1].trim()) : '';
        if (en && uk && /[a-z]/i.test(en) && /[а-щьюяєіїґ]/i.test(uk)) out.push(en, uk);
      }
      return out;
    };

    const kept = validPairs(entry.examples);
    if (kept.length > 0) return kept;

    const text = (entry.text ?? '').trim();
    if (!text) return [];
    try {
      this.assertOpenAiAvailable();
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Ти укладаєш англо-український словник. Склади 2 короткі природні приклади вживання англійського слова ' +
              `(кожне речення до ${WordGenerationService.MAX_EXAMPLE_LENGTH} символів) і їхній переклад українською. ` +
              'Слово має бути вжите в реченні саме в цьому значенні. Без крапки в кінці. ' +
              'Поверни масив з 4 рядків: [англ 1, укр 1, англ 2, укр 2].',
          },
          {
            role: 'user',
            content:
              `Слово: "${text}"` +
              (entry.partOfSpeech ? `\nЧастина мови: ${entry.partOfSpeech}` : '') +
              (entry.translation ? `\nПереклад: ${entry.translation}` : ''),
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'examples_repair_v1',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['examples'],
              properties: { examples: { type: 'array', items: { type: 'string' } } },
            },
          },
        } as any,
      });
      const raw = response.choices[0]?.message?.content;
      const examples = raw ? enforceExampleArrayConstraints(JSON.parse(raw).examples, WordGenerationService.MAX_EXAMPLE_LENGTH) : [];
      return validPairs(examples);
    } catch (error) {
      this.logger.warn(`Ремонт прикладів "${text}" не вдався: ${(error as Error)?.message}`);
      return [];
    }
  }

  /**
   * Переклад, що не пройшов перевірку: задовгий — лишаємо перші варіанти;
   * інакше — короткий запит перекладу (у реченні книги, якщо воно є). Якщо й
   * це не вдалося — лишається як був (тоді вирішує blockingProblems).
   */
  private async repairTranslation(text: string, current: string): Promise<string> {
    const value = current.trim();
    const problems = validateUkrainianTranslation(value);
    if (problems.length === 1 && problems[0] === 'translation_too_long') {
      return shortenTranslation(value);
    }
    const reader = this.readerTap();
    const candidate = await this.fetchGuaranteedTranslation(text, reader?.rawContext)
      .then(r => r.translation)
      .catch(() => '');
    if (candidate) return candidate;
    return value.length > 120 ? shortenTranslation(value) : value;
  }

  /**
   * Тап у книзі: є речення, з якого натиснули слово. Тоді слово точно
   * існує в тексті — його не можна "не знайти".
   */
  private readerTap(): { surface: string; rawContext?: string } | null {
    const scope = this.lookupScope.getStore();
    if (!scope) return null;
    const hasSentence = !!scope.rawContext && !!this.sanitizeContext(scope.rawContext);
    if (!scope.reader && !hasSentence) return null;
    return { surface: scope.surface, rawContext: scope.rawContext };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Одне слово: форма → значення (частина мови + речення)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Чи йде слово новим шляхом розбору. Службові слова (включно з
   * кількісними many/much/few/little) і числівники мають детерміновану
   * обробку в класифікаторі — їх не чіпаємо. Ступені порівняння
   * (better, worse, older) йдуть новим шляхом: better → good, а якщо в
   * словнику є і прислівник well — вибір за реченням.
   */
  private isPlainSingleWord(lowerQuery: string): boolean {
    if (!/^[a-z]{2,40}$/.test(lowerQuery)) return false;
    if (classifyClosedClassWord(lowerQuery)) return false;
    if (classifyNumeralWord(lowerQuery)) return false;
    return true;
  }

  /** Записи словника, що можуть відповідати слову: саме слово, кандидати-леми, forms. */
  private async loadLexEntries(surface: string, analyses: InflectionAnalysis[]): Promise<Word[]> {
    const texts = Array.from(new Set([surface, ...analyses.map(a => a.lemma)]));
    return this.wordRepo
      .createQueryBuilder('word')
      .where('LOWER(word.text) IN (:...texts)', { texts })
      .orWhere('word.forms @> ARRAY[CAST(:surface AS text)]', { surface })
      .orderBy('word.id', 'ASC')
      .getMany();
  }

  private async findSensesByText(text: string): Promise<Word[]> {
    return this.wordRepo
      .createQueryBuilder('word')
      .where('LOWER(word.text) = :text', { text: text.toLowerCase() })
      .orderBy('word.id', 'ASC')
      .getMany();
  }

  /**
   * Повертає запис для одного слова або null, якщо слово треба обробити
   * загальним шляхом (напр. самостійне слово, якого ще немає в словнику —
   * загальний шлях генерує його з фіксованою лемою).
   */
  private async searchOrCreateSingleWord(
    surface: string,
    providedPartOfSpeech: string | undefined,
    context: string | undefined,
  ): Promise<Word | null> {
    const alias = await this.aliasRepo.findOne({ where: { surface }, relations: ['word'] });
    if (alias?.source === 'admin' && alias.word) {
      this.logger.log(`📌 Ручний виняток: "${surface}" → "${alias.word.text}" (#${alias.word.id})`);
      return alias.word;
    }

    const standalone = isStandaloneWord(surface);
    const analyses = standalone ? [] : analyzeInflections(surface);
    const entries = await this.loadLexEntries(surface, analyses);

    if (alias?.source === 'ai' && alias.word && !entries.some(e => e.text.toLowerCase() === surface)) {
      return alias.word;
    }

    const libraryMatch = await this.phraseLibraryRepo
      .createQueryBuilder('phraseLib')
      .where('LOWER(phraseLib.surfaceForm) = :query', { query: surface })
      .getOne();
    const hintPos = libraryMatch?.partOfSpeech || providedPartOfSpeech || null;

    const plan = planResolution({
      surface,
      entries,
      analyses,
      cue: contextCue(surface, context),
      hasContext: !!context,
      explicitAmbiguous: AMBIGUOUS_FORMS.has(surface),
      libraryPos: hintPos,
    });

    this.logger.log(
      `🔎 "${surface}": ${plan.action} — ${plan.reason}` +
      (plan.options.length ? ` [${plan.options.map(o => `${o.key}:${o.kind}`).join(', ')}]` : ''),
    );

    if (standalone && plan.action === 'unknown') return null;

    // Саме слово вже є в словнику ("wrong" — прикметник), а план хоче
    // уточнити значення через AI або створити нове ("wrong" — прислівник):
    // збій чи затримка AI не мають лишати користувача без перекладу.
    const ownEntry = plan.options
      .filter(o => o.type === 'existing' && o.kind === 'surface' && o.entry)
      .sort((a, b) => a.entry!.id - b.entry!.id)[0]?.entry as Word | undefined;
    if (!ownEntry || plan.action === 'return') {
      return this.executeResolutionPlan(surface, plan, context, hintPos);
    }
    return this.resolveWithExistingFallback(
      surface,
      this.executeResolutionPlan(surface, plan, context, hintPos),
      ownEntry,
    );
  }

  /**
   * Чекає на результат не довше NEW_SENSE_BUDGET_MS; при помилці чи
   * перевищенні часу повертає наявний запис слова. Незавершена генерація
   * триває у фоні — наступне натискання отримає вже збережене значення.
   */
  private async resolveWithExistingFallback(surface: string, pending: Promise<Word>, fallback: Word): Promise<Word> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), WordGenerationService.NEW_SENSE_BUDGET_MS);
    });
    const guarded = pending.catch((error: unknown) => {
      this.logger.warn(
        `↩️ "${surface}": уточнення значення не вдалося (${(error as Error)?.message}) — повертаю наявний запис #${fallback.id}`,
      );
      return fallback;
    });
    try {
      const result = await Promise.race([guarded, timeout]);
      if (result === 'timeout') {
        this.logger.warn(
          `⏱ "${surface}": уточнення значення триває довше ${WordGenerationService.NEW_SENSE_BUDGET_MS}мс — повертаю наявний запис #${fallback.id}`,
        );
        return fallback;
      }
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Діагностика для адмінки: як буде розібрано слово (без AI і без змін у
   * БД). Показує розбори форми, знайдені записи, підказку з речення і план.
   */
  async diagnoseSingleWord(rawSurface: string, rawContext?: string) {
    const surface = rawSurface.replace(/[’‘]/g, "'").trim().toLowerCase();
    const context = this.sanitizeContext(rawContext);
    const alias = await this.aliasRepo.findOne({ where: { surface }, relations: ['word'] });
    const plain = this.isPlainSingleWord(surface);
    const standalone = isStandaloneWord(surface);
    const analyses = plain && !standalone ? analyzeInflections(surface) : [];
    const entries = plain ? await this.loadLexEntries(surface, analyses) : [];
    const cue = contextCue(surface, context);
    const plan = plain
      ? planResolution({
          surface,
          entries,
          analyses,
          cue,
          hasContext: !!context,
          explicitAmbiguous: AMBIGUOUS_FORMS.has(surface),
          libraryPos: null,
        })
      : null;

    return {
      surface,
      context: context ?? null,
      handledBy: !plain ? 'legacy' : alias?.source === 'admin' ? 'admin_alias' : 'single_word',
      alias: alias
        ? { id: alias.id, source: alias.source, word: alias.word ? { id: alias.word.id, text: alias.word.text, partOfSpeech: alias.word.partOfSpeech, translation: alias.word.translation } : null }
        : null,
      standalone,
      ambiguousForm: AMBIGUOUS_FORMS.has(surface) || isIngForm(surface),
      analyses,
      cue,
      entries: entries.map(e => ({ id: e.id, text: e.text, senseKey: e.senseKey, partOfSpeech: e.partOfSpeech, translation: e.translation, forms: e.forms })),
      plan: plan
        ? {
            action: plan.action,
            reason: plan.reason,
            option: plan.option ? { key: plan.option.key, lemma: plan.option.lemma, pos: plan.option.pos, kind: plan.option.kind } : null,
            options: plan.options.map(o => ({ key: o.key, type: o.type, lemma: o.lemma, pos: o.pos, kind: o.kind, confirmed: o.confirmed, translation: o.entry?.translation ?? null })),
          }
        : null,
    };
  }

  private async executeResolutionPlan(
    surface: string,
    plan: ResolutionPlan,
    context: string | undefined,
    hintPos: string | null,
  ): Promise<Word> {
    switch (plan.action) {
      case 'return':
        return plan.option!.entry as Word;
      case 'create':
        return this.createSingleWordEntry(plan.option!.lemma, plan.option!.pos, context);
      case 'separate':
        return this.createSingleWordEntry(surface, hintPos, context);
      case 'ask_ai': {
        const choice = await this.chooseSenseInContext(surface, plan.options, context!);
        if (choice) return choice;
        // AI недоступний — детермінований вибір без контексту.
        const fallback = planResolution({
          surface,
          entries: plan.options.filter(o => o.entry).map(o => o.entry!),
          analyses: analyzeInflections(surface),
          cue: null,
          hasContext: false,
          explicitAmbiguous: AMBIGUOUS_FORMS.has(surface),
          libraryPos: hintPos,
        });
        if (fallback.action === 'ask_ai') return this.resolveUnknownSingleWord(surface, context, hintPos);
        return this.executeResolutionPlan(surface, fallback, undefined, hintPos);
      }
      case 'unknown':
      default:
        return this.resolveUnknownSingleWord(surface, context, hintPos);
    }
  }

  /**
   * Вибір значення за реченням (дешева модель + кеш). Варіанти вже
   * граматично перевірені; AI лише вирішує, яке з них ужито. Вибір
   * "other" (жоден не підходить) теж перевіряється морфологією.
   * Повертає null, якщо AI недоступний.
   */
  private async chooseSenseInContext(
    surface: string,
    options: SenseOption[],
    context: string,
  ): Promise<Word | null> {
    const OTHER = 'other';
    const keys = options.map(o => o.key);
    const hash = createHash('sha1')
      .update(`${surface}|${[...keys].sort().join(',')}|${context.toLowerCase()}`)
      .digest('hex');
    const cacheKey = `v3:word-sense:${hash}`;

    type Decision = { usage?: string; choice: string; lemma: string; partOfSpeech: string; evidence?: string };
    let decision = (await this.aiCache.get<Decision>(cacheKey)) ?? undefined;

    if (!decision) {
      try {
        this.assertOpenAiAvailable();
        const describe = (o: SenseOption): string => {
          const posLabel = o.pos ?? 'частина мови невідома';
          const form =
            o.kind === 'surface' || o.kind === 'base'
              ? `слово "${surface}" саме по собі`
              : o.kind === 'forms'
                ? `"${surface}" — збережена форма цього слова`
                : `"${surface}" — ${INFLECTION_KIND_LABEL_UK[o.kind]} "${o.lemma}"`;
          if (o.type === 'existing') {
            return `- ${o.key}: лема "${o.lemma}" як ${posLabel}; переклад у словнику: "${o.entry?.translation ?? ''}"; ${form}`;
          }
          return `- ${o.key}: лема "${o.lemma}" як ${posLabel} (такого значення в словнику ще немає); ${form}`;
        };

        const response = await this.openai.chat.completions.create({
          model: WordGenerationService.CONTEXT_MODEL,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                'Ти лінгвіст-лексикограф англійської мови. Визнач, до якого словникового запису належить слово ' +
                'в цьому реченні. Варіанти вже перевірені морфологічно; обирай за СИНТАКСИСОМ, а не за частотністю.\n' +
                'Тести, по черзі:\n' +
                'A. ДІЄСЛІВНЕ вживання (usage = verbal) → варіант, де лема — базове ДІЄСЛОВО (форми verb_ing / verb_past / ' +
                'verb_3sg):\n' +
                '   - слово входить у дієслівну групу (be / have / модальне + форма: "was telling", "has told");\n' +
                '   - має прямий додаток, доповнення чи обставину ("telling ME the truth", "walking HOME");\n' +
                '   - стоїть після keep / start / stop / finish / avoid / enjoy / mind або прийменника ' +
                '(without / by / after / before) і має додаток ("without telling anyone", "kept walking").\n' +
                'B. ІМЕННИКОВЕ вживання (usage = nominal) → запис самого слова як іменник, ЛИШЕ якщо є артикль / ' +
                'присвійний займенник або множина і НЕМАЄ додатка ("the meeting", "their trainings", "the telling of the story").\n' +
                'C. ПРИКМЕТНИКОВЕ вживання (usage = adjectival) → лише якщо означення перед іменником або присудок, ' +
                'що має ступені ("a telling sign", "very boring", "The film was amazing").\n' +
                'D. "other" — лише коли жоден варіант не підходить; тоді lemma (словникова форма, нижній регістр) ' +
                'і partOfSpeech для цього ужитку.\n' +
                'Ніколи не зводь словотвір до кореня: wooden ≠ wood, teacher ≠ teach, golden ≠ gold.\n' +
                'Для обраного варіанта заповни lemma і partOfSpeech відповідно до нього; evidence — 1–3 слова речення, ' +
                'що вирішили вибір.\n' +
                'Приклади: "He noticed how hard the young man trained" + [train noun "поїзд", train verb] → verbal, train verb; ' +
                '"The training was hard" + [train verb] → nominal, other, lemma "training", noun; ' +
                '"She kept telling me the truth" + [telling adjective, tell verb] → verbal, tell verb; ' +
                '"It was a telling sign" + [telling adjective, tell verb] → adjectival, telling adjective; ' +
                '"Turn left at the bank" + [leave verb] → other, lemma "left", adverb.',
            },
            {
              role: 'user',
              content:
                `Слово: "${surface}"\nРечення: «${context}»\nВаріанти:\n` +
                options.map(describe).join('\n') +
                `\n- ${OTHER}: жоден варіант не підходить`,
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'word_sense_choice',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  usage: { type: 'string', enum: ['verbal', 'nominal', 'adjectival', 'adverbial', 'other'] },
                  choice: { type: 'string', enum: [...keys, OTHER] },
                  lemma: { type: 'string' },
                  partOfSpeech: {
                    type: 'string',
                    enum: ['noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'conjunction', 'interjection', 'numeral', 'none'],
                  },
                  evidence: { type: 'string' },
                },
                required: ['usage', 'choice', 'lemma', 'partOfSpeech', 'evidence'],
              },
            },
          } as any,
        });
        const content = response.choices[0]?.message?.content;
        decision = content ? (JSON.parse(content) as Decision) : undefined;
        if (decision) await this.aiCache.set(cacheKey, 'word-sense', decision);
      } catch (error) {
        this.logger.warn(`Не вдалося обрати значення "${surface}" за контекстом: ${(error as Error)?.message}`);
        return null;
      }
    }

    if (!decision) return null;

    let picked = options.find(o => o.key === decision!.choice);

    // Модель назвала вживання дієслівним, але обрала недієслівний запис
    // (або навпаки) — довіряємо синтаксичному тесту, а не вибору.
    if (picked && decision.usage === 'verbal' && picked.cls !== 'verb') {
      const verbOption = options.find(o => o.cls === 'verb' && o.kind !== 'surface');
      if (verbOption) {
        this.logger.warn(`🧭 "${surface}": usage=verbal, але обрано ${picked.key} — беру ${verbOption.key}`);
        picked = verbOption;
      }
    } else if (picked && decision.usage === 'nominal' && picked.cls === 'verb') {
      const nounOption = options.find(o => o.cls === 'noun');
      if (nounOption) {
        this.logger.warn(`🧭 "${surface}": usage=nominal, але обрано ${picked.key} — беру ${nounOption.key}`);
        picked = nounOption;
      }
    }

    if (picked) {
      this.logger.log(`🧭 "${surface}" за контекстом → ${picked.key} (${picked.lemma}, ${picked.pos})`);
      if (picked.type === 'existing') return picked.entry as Word;
      return this.createSingleWordEntry(picked.lemma, picked.pos, context);
    }

    return this.resolveOtherChoice(surface, decision.lemma, decision.partOfSpeech, context);
  }

  /** Варіант "other" від AI: лема й частина мови, перевірені морфологією. */
  private async resolveOtherChoice(
    surface: string,
    rawLemma: string,
    rawPos: string,
    context: string | undefined,
  ): Promise<Word> {
    const lemma = String(rawLemma ?? '').trim().toLowerCase();
    const pos = rawPos && rawPos !== 'none' ? rawPos : null;

    let finalLemma = surface;
    if (lemma && lemma !== surface && /^[a-z]+$/.test(lemma)) {
      if (inflectionKindOf(surface, lemma, lemmaPosOf(pos))) {
        finalLemma = lemma;
      } else {
        this.logger.warn(
          `⚠️ AI запропонував лему "${lemma}" (${pos}) для "${surface}", але "${surface}" не є її граматичною формою — лишаю саме слово.`,
        );
      }
    }
    this.logger.log(`🧭 "${surface}" за контекстом → інше значення: "${finalLemma}" (${pos ?? '?'})`);
    return this.createSingleWordEntry(finalLemma, pos, context);
  }

  /**
   * Слова немає у словнику ні як такого, ні як форми відомої леми:
   * лему визначає AI (з урахуванням речення), а результат перевіряється
   * морфологією — AI не може звести "wooden" до "wood".
   */
  private async resolveUnknownSingleWord(
    surface: string,
    context: string | undefined,
    hintPos: string | null,
  ): Promise<Word> {
    const structure = classifyQueryStructure(surface);

    // -ly та лексикалізовані -ing прикметники — лема фіксована (як і раніше).
    if (structure.lockedLemma) {
      return this.createSingleWordEntry(surface, hintPos, context);
    }
    if (isStandaloneWord(surface) || (isAmbiguousForm(surface) && !context)) {
      return this.createSingleWordEntry(surface, hintPos, context);
    }

    this.assertOpenAiAvailable();
    const ai = await this.resolveSingleWordLemmaViaAi(surface, context);
    const aiLemma = String(ai.text ?? '').trim().toLowerCase();
    const aiPos = ai.partOfSpeech && ai.partOfSpeech !== 'none' ? ai.partOfSpeech : null;

    let lemma = surface;
    let pos: string | null = hintPos ?? aiPos;
    if (aiLemma && aiLemma !== surface) {
      const kind = /^[a-z]+$/.test(aiLemma) ? inflectionKindOf(surface, aiLemma, lemmaPosOf(aiPos)) : null;
      if (kind) {
        lemma = aiLemma;
        pos = aiPos ?? hintPos;
      } else {
        this.logger.warn(
          `⚠️ AI звів "${surface}" до "${aiLemma}" (${aiPos}), але це не словозміна — лишаю "${surface}".`,
        );
      }
    }

    const word = await this.createSingleWordEntry(lemma, pos, context);

    // Однозначну форму запам'ятовуємо, щоб наступні натискання не йшли в AI.
    if (word.text.toLowerCase() !== surface && !isAmbiguousForm(surface) && !surface.endsWith('s')) {
      await this.saveAiAlias(surface, word);
    }
    return word;
  }

  private async saveAiAlias(surface: string, word: Word): Promise<void> {
    try {
      await this.aliasRepo
        .createQueryBuilder()
        .insert()
        .into(WordSurfaceAlias)
        .values({ surface, wordId: word.id, source: 'ai' })
        .orIgnore()
        .execute();
    } catch (error) {
      this.logger.warn(`Не вдалося зберегти псевдонім "${surface}": ${(error as Error)?.message}`);
    }
  }

  /**
   * Повертає наявний запис лема + частина мови або створює його. Якщо
   * лема вже є з іншою частиною мови — створюється ДОДАТКОВЕ значення
   * (senseKey = частина мови), основний запис не змінюється.
   */
  private async createSingleWordEntry(
    rawLemma: string,
    partOfSpeech: string | null | undefined,
    context: string | undefined,
  ): Promise<Word> {
    const lemma = rawLemma.trim().toLowerCase();
    const requestedPos = partOfSpeech && partOfSpeech !== 'none' ? partOfSpeech : null;
    const senses = await this.findSensesByText(lemma);

    const sameClass = (w: Word, pos: string) => {
      const a = posClassOf(w.partOfSpeech);
      const b = posClassOf(pos);
      return a === b || a === 'unknown';
    };

    if (requestedPos) {
      const hit = senses.find(w => sameClass(w, requestedPos));
      if (hit) return hit;
    } else if (senses.length > 0) {
      return senses[0];
    }

    this.assertOpenAiAvailable();
    this.logger.log(
      `✨ Нове ${senses.length ? 'додаткове значення' : 'слово'}: "${lemma}" (${requestedPos ?? 'частину мови визначить AI'})`,
    );

    const allowed: PartOfSpeech[] = [
      'noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'conjunction', 'interjection', 'numeral',
    ];

    // ⚡ Тап у читалці і частина мови відома наперед: щойно модель видасть
    // переклад леми, розбір форми в реченні стартує паралельно з генерацією
    // прикладів — з тими самими text / partOfSpeech / translation, які
    // отримає збережений запис (нижче: text = lemma, translation.toLowerCase()).
    const prefetchPos = requestedPos && (allowed as string[]).includes(requestedPos) ? (requestedPos as PartOfSpeech) : null;
    const onTranslation =
      prefetchPos && this.lookupScope.getStore()
        ? (translation: string) =>
            this.startSurfacePrefetch({ text: lemma, partOfSpeech: prefetchPos, translation: String(translation).toLowerCase() })
        : undefined;

    const creative = await this.generateContentForKnownLemma(
      lemma,
      !requestedPos,
      requestedPos ?? undefined,
      { context, partOfSpeech: requestedPos ?? undefined },
      onTranslation,
    );

    const rawPos = requestedPos ?? creative.partOfSpeech ?? null;
    const finalPos: PartOfSpeech | null = rawPos && (allowed as string[]).includes(rawPos) ? (rawPos as PartOfSpeech) : null;

    // AI визначив частину мови, а таке значення вже існує.
    if (!requestedPos && finalPos) {
      const hit = senses.find(w => sameClass(w, finalPos));
      if (hit) return hit;
    }

    const senseKey = senses.length === 0 ? '' : (finalPos ?? 'none');
    const forms = this.computeForms(lemma, finalPos, true);

    const newWord = this.wordRepo.create({
      text: lemma,
      senseKey,
      translation: String(creative.translation).toLowerCase(),
      pronunciation: creative.pronunciation,
      type: 'word',
      partOfSpeech: finalPos ?? undefined,
      examples: creative.examples,
      level: creative.level === 'none' ? undefined : creative.level,
      forms,
      description: '',
      definitions: [],
      isProperNoun: !!creative.isProperNoun,
    });

    await this.prepareEntryForSave(newWord, creative);

    try {
      const saved = await this.wordRepo.save(newWord);
      await Promise.all([
        this.cacheService.clear(WordGenerationService.ALL_WORDS_CACHE_KEY),
        this.cacheService.clear(WordGenerationService.ALL_WORDS_SHORT_CACHE_KEY),
      ]);
      return saved;
    } catch (error: any) {
      if (error?.code === '23505') {
        const raced = await this.wordRepo.findOne({ where: { text: lemma, senseKey } });
        if (raced) return raced;
      }
      throw error;
    }
  }

  /**
   * Лема і частина мови для одного слова, якого немає в словнику. Окремий
   * промпт від фразового (resolveLemmaViaAi лишився без змін для фраз):
   * тут головне — розрізнити словозміну і словотвір та врахувати речення.
   */
  private async resolveSingleWordLemmaViaAi(
    surface: string,
    context?: string,
  ): Promise<{ text: string; partOfSpeech: string }> {
    this.assertOpenAiAvailable();

    const systemPrompt = `Ти професійний лінгвіст англійської мови. Зведи ОДНЕ слово до словникової форми (lemma)
і визнач його частину мови в цьому ужитку.

ЗВОДЬ ЛИШЕ СЛОВОЗМІНУ — граматичні форми того самого слова:
  множина: apples → apple, children → child, knives → knife
  3-тя особа / минулий час / дієприкметник / -ing: works → work, trained → train, went → go,
    written → write, slain → slay, stopped → stop, studying → study
  ступені порівняння: bigger → big, happiest → happy, better → good
  присвійна форма імені: Ivan's → Ivan

НІКОЛИ НЕ ЗВОДЬ СЛОВОТВІР — похідне слово є окремою словниковою одиницею:
  wooden → wooden (НЕ wood), golden → golden, woollen → woollen, teacher → teacher (НЕ teach),
  happiness → happiness, careful → careful, quickly → quickly, kitchen → kitchen, building → building
  (коли це іменник "будівля"), meeting → meeting (іменник "зустріч"), tired → tired (прикметник "втомлений").

Частина мови — СТРОГО одне з: noun, verb, adjective, adverb, pronoun, preposition, conjunction,
interjection, numeral, none. Визнач її для ролі слова В РЕЧЕННІ (якщо речення дано):
"the young man trained" → train, verb; "the training was hard" → training, noun;
"he was tired" → tired, adjective; "they walked into the room" → walk, verb.
Для власних імен людей — noun, ім'я з великої літери.
СУВОРО ЗАБОРОНЕНО повертати скорочення з апострофами.

Поверни ЛИШЕ JSON.`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: context
              ? `Слово: "${surface}"\nРечення: «${context}»`
              : `Слово: "${surface}" (без речення — найчастіше вживання)`,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'single_word_lemma',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string' },
                partOfSpeech: {
                  type: 'string',
                  enum: ['noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'conjunction', 'interjection', 'numeral', 'none'],
                },
              },
              required: ['text', 'partOfSpeech'],
            },
          },
        } as any,
      });
      const content = response.choices[0]?.message?.content;
      if (!content) throw new InternalServerErrorException('AI повернув порожню відповідь при визначенні леми');
      return JSON.parse(content) as { text: string; partOfSpeech: string };
    } catch (error) {
      this.handleOpenAiError(error, `resolveSingleWordLemmaViaAi("${surface}")`);
    }
  }

  /**
   * Головний вхід (читалка й ручне додавання): знайти слово в словнику або
   * згенерувати його.
   *  - Український запит спершу зводиться до англійського (resolveUkrainianQuery);
   *  - якщо згенерований контент не пройшов перевірку, у БД нічого не
   *    пишеться, а користувач отримує переклад без збереження
   *    (transient = true) замість помилки.
   */
  async searchOrCreateGlobalWord(
    query: string,
    providedPartOfSpeech?: string,
    rawContext?: string,
    options?: { reader?: boolean },
  ): Promise<Word> {
    const startedAt = Date.now();
    let englishQuery = normalizeLookupQuery(query);
    if (!englishQuery) {
      throw new NotFoundException(`Не вдалося знайти переклад для «${String(query ?? '').trim()}». Перевірте написання.`);
    }

    if (hasCyrillic(englishQuery)) {
      const resolved = await this.resolveUkrainianQuery(englishQuery);
      if (!resolved) {
        throw new NotFoundException(`Не вдалося знайти переклад для «${englishQuery}». Перевірте написання.`);
      }
      if (resolved.matchedWord) return resolved.matchedWord;
      englishQuery = resolved.english;
    }

    const lookupQuery = englishQuery;
    const flightKey = JSON.stringify([lookupQuery, providedPartOfSpeech ?? null, rawContext ?? null]);
    const joined = this.lookupFlight.has(flightKey);
    // Форма, як її рахує WordService для розбору ("made"), і речення тапу.
    const scope = hasCyrillic(normalizeLookupQuery(query))
      ? undefined
      : { surface: normalizeLookupQuery(query).toLowerCase(), rawContext, reader: !!options?.reader };
    const word = await this.lookupFlight.run(flightKey, async () => {
      if (!scope) return this.findOrGenerateWordOrTransient(lookupQuery, providedPartOfSpeech, rawContext);
      return this.lookupScope.run(scope, async () => {
        if (!this.readerTap()) return this.findOrGenerateWordOrTransient(lookupQuery, providedPartOfSpeech, rawContext);
        try {
          return await this.findOrGenerateWord(lookupQuery, providedPartOfSpeech, rawContext);
        } catch (error) {
          return this.recoverBookLookup(lookupQuery, providedPartOfSpeech, rawContext, error, startedAt);
        }
      });
    });
    // Викликач далі доповнює об'єкт для відповіді (forms, підсвітки) — той,
    // хто приєднався до чужого запиту, отримує власну копію.
    return joined ? cloneEntity(word) : word;
  }

  /** Поза книгою (ручний ввід, адмінка) — як і раніше: відхилений запис → переклад без збереження. */
  private async findOrGenerateWordOrTransient(query: string, providedPartOfSpeech?: string, rawContext?: string): Promise<Word> {
    try {
      return await this.findOrGenerateWord(query, providedPartOfSpeech, rawContext);
    } catch (error) {
      if (error instanceof GenerationRejectedError) {
        this.logger.warn(`🚫 Запис не збережено: ${error.message}`);
        return this.buildTransientWord(query, rawContext);
      }
      throw error;
    }
  }

  private static readonly BOOK_RETRY_WINDOW_MS = 12_000;
  private static readonly BOOK_MAX_PAUSE_WAIT_MS = 8_000;

  private isOutOfFunds(): boolean {
    const until = WordGenerationService.openAiOutOfFundsUntil;
    return !!until && Date.now() < until;
  }

  /** Коротка пауза ШІ ("забагато запитів за хвилину") — дочекатися, а не відмовляти. */
  private async waitForShortAiPause(): Promise<void> {
    const until = WordGenerationService.openAiQuotaBlockedUntil;
    const left = until ? until - Date.now() : 0;
    if (left > 0 && left <= WordGenerationService.BOOK_MAX_PAUSE_WAIT_MS && !this.isOutOfFunds()) {
      await new Promise(resolve => setTimeout(resolve, left + 50));
    }
  }

  /**
   * ГАРАНТІЯ ПЕРЕКЛАДУ для тапу в книзі. Слово з тексту книги не може
   * лишитись без перекладу, крім двох випадків: на рахунку OpenAI немає
   * коштів (а слова ще немає в базі) або сервер / AI повністю недоступний.
   *  1. тимчасовий збій (таймаут, обрив, "забагато запитів") — один повтор
   *     основного шляху;
   *  2. якщо основний шлях усе одно не дав запису (у т.ч. відхилений
   *     перевіркою) — запис створюється з перекладу, який GPT зобов'язаний
   *     дати (createGuaranteedEntry).
   */
  private async recoverBookLookup(
    query: string,
    providedPartOfSpeech: string | undefined,
    rawContext: string | undefined,
    firstError: unknown,
    startedAt: number,
  ): Promise<Word> {
    if (this.isOutOfFunds()) throw firstError;
    let lastError = firstError;
    this.logger.warn(`🛟 "${query}": основний шлях не дав запису (${(firstError as Error)?.message}) — відновлення`);

    const rejected = firstError instanceof GenerationRejectedError;
    if (!rejected && Date.now() - startedAt < WordGenerationService.BOOK_RETRY_WINDOW_MS) {
      await this.waitForShortAiPause();
      try {
        return await this.findOrGenerateWord(query, providedPartOfSpeech, rawContext);
      } catch (error) {
        if (this.isOutOfFunds()) throw error;
        lastError = error;
      }
    }

    const lemmaHint = lastError instanceof GenerationRejectedError ? lastError.query.trim().toLowerCase() : '';
    return this.createGuaranteedEntry(lemmaHint || query.trim().toLowerCase(), rawContext, providedPartOfSpeech);
  }

  /**
   * Запис словника з перекладу, який GPT зобов'язаний дати (без права
   * відповісти "такого слова немає"). Вимова і приклади — окремими короткими
   * запитами; якщо вони не вдались, запис усе одно зберігається.
   */
  private async createGuaranteedEntry(text: string, rawContext?: string, providedPartOfSpeech?: string): Promise<Word> {
    const existing = await this.wordRepo.findOne({ where: { text }, order: { id: 'ASC' } });
    if (existing) return existing;

    const guaranteed = await this.fetchGuaranteedTranslation(text, rawContext);
    const allowed: PartOfSpeech[] = [
      'noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'conjunction', 'interjection', 'numeral',
    ];
    const rawPos = providedPartOfSpeech && providedPartOfSpeech !== 'none' ? providedPartOfSpeech : guaranteed.partOfSpeech;
    const isMultiWord = text.split(/\s+/).filter(Boolean).length > 1;
    const partOfSpeech = !isMultiWord && (allowed as string[]).includes(rawPos) ? (rawPos as PartOfSpeech) : null;

    const entry = this.wordRepo.create({
      text,
      senseKey: '',
      translation: guaranteed.translation,
      pronunciation: '',
      // Кілька слів із книги — завжди фразове дієслово.
      type: isMultiWord ? 'phrasal_verb' : 'word',
      partOfSpeech: partOfSpeech ?? undefined,
      examples: [],
      forms: isMultiWord ? [] : this.computeForms(text, partOfSpeech, false),
      description: '',
      definitions: [],
      isProperNoun: false,
    });
    const [pronunciation, examples] = await Promise.all([
      this.repairPronunciation(text, '').catch(() => ''),
      this.repairExamples(entry).catch(() => [] as string[]),
    ]);
    entry.pronunciation = pronunciation;
    entry.examples = examples;

    try {
      const saved = await this.wordRepo.save(entry);
      this.logger.warn(`🛟 "${text}": збережено гарантований запис #${saved.id} ("${saved.translation}")`);
      await Promise.all([
        this.cacheService.clear(WordGenerationService.ALL_WORDS_CACHE_KEY),
        this.cacheService.clear(WordGenerationService.ALL_WORDS_SHORT_CACHE_KEY),
      ]);
      return saved;
    } catch (error: any) {
      if (error?.code === '23505') {
        const raced = await this.wordRepo.findOne({ where: { text, senseKey: '' } });
        if (raced) return raced;
      }
      throw error;
    }
  }

  /**
   * Переклад, який GPT ЗОБОВ'ЯЗАНИЙ дати: імена, сленг, вигадані слова,
   * вигуки — транслітерація або найближчий відповідник; порожня відповідь
   * заборонена. До 3 спроб (коротка пауза ШІ перечікується). Кидає помилку
   * лише якщо немає коштів або AI недоступний усі спроби.
   */
  private async fetchGuaranteedTranslation(
    text: string,
    rawContext?: string,
  ): Promise<{ translation: string; partOfSpeech: string }> {
    // Без кешу: запит іде лише коли запис створюється заново (слова немає
    // в базі), і тоді переклад має бути згенерований наново.
    const context = this.sanitizeContext(rawContext);

    const normalize = (raw: unknown): string => {
      const value = String(raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!/[а-щьюяєіїґ]/i.test(value)) return '';
      return value.length > 120 ? shortenTranslation(value) : value;
    };

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.waitForShortAiPause();
        this.assertOpenAiAvailable();
        const response = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                'You are an English-Ukrainian dictionary. ALWAYS give a Ukrainian translation of the English word or ' +
                'phrase: 1-2 variants separated by " / ", Ukrainian letters only, no explanations. If a sentence is ' +
                'given, translate the sense used in that sentence. Proper names, brands, invented words, slang, ' +
                'interjections and abbreviations: give the Ukrainian transliteration or the closest equivalent. ' +
                'The translation must NEVER be empty and must never say that there is no translation.',
            },
            {
              role: 'user',
              content: context ? `Word: "${text}"\nSentence: «${context}»` : `Word: "${text}"`,
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'guaranteed_translation_v1',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['translation', 'partOfSpeech'],
                properties: {
                  translation: { type: 'string' },
                  partOfSpeech: {
                    type: 'string',
                    enum: ['noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'conjunction', 'interjection', 'numeral', 'none'],
                  },
                },
              },
            },
          } as any,
        });
        const raw = response.choices[0]?.message?.content;
        const parsed = raw ? JSON.parse(raw) : null;
        const translation = normalize(parsed?.translation);
        if (translation) {
          return { translation, partOfSpeech: String(parsed?.partOfSpeech ?? 'none') };
        }
        lastError = new Error('порожній переклад');
      } catch (error) {
        lastError = error;
        // Реєструє паузу ШІ (429) і позначку "немає коштів".
        if (!(error instanceof ServiceUnavailableException)) {
          try {
            this.handleOpenAiError(error, `fetchGuaranteedTranslation("${text}")`);
          } catch (mapped) {
            lastError = mapped;
          }
        }
        if (this.isOutOfFunds()) throw lastError;
        await new Promise(resolve => setTimeout(resolve, 400 * attempt));
      }
    }

    // GPT тричі не дав українського перекладу — транслітерація як переклад.
    const transliteration = await this.repairPronunciation(text, '').catch(() => '');
    if (transliteration) return { translation: transliteration, partOfSpeech: 'none' };
    throw lastError instanceof Error ? lastError : new InternalServerErrorException('Не вдалося виконати запит через AI');
  }

  /**
   * Український ввід → англійський запит. Порядок:
   *   1. точний збіг з одним із варіантів перекладу в БД (не підрядок:
   *      раніше "рука" знаходила "порука");
   *   2. забута розкладка ("фззду" → apple) — лише якщо таке англійське
   *      слово є в словнику або лексиконі; інакше "машина часу" ставала
   *      "vfibyf xfce";
   *   3. AI-переклад зі строгою схемою.
   * null — не вдалося (у БД нічого не створюється).
   */
  async resolveUkrainianQuery(raw: string): Promise<UkrainianQueryResolution | null> {
    const text = raw
      .normalize('NFC')
      .toLowerCase()
      .replace(/[’‘`´ʼ]/g, "'")
      .replace(/\s+/g, ' ')
      .replace(/^[.,!?;:"«»()\[\]]+|[.,!?;:"«»()\[\]]+$/g, '')
      .trim();
    if (!text) return null;

    const byTranslation = await this.wordRepo
      .createQueryBuilder('word')
      .where(
        `EXISTS (SELECT 1 FROM unnest(regexp_split_to_array(LOWER(word.translation), '\\s*[/,;]\\s*')) AS t(v) WHERE btrim(t.v) = :q)`,
        { q: text },
      )
      .orderBy('word.id', 'ASC')
      .getOne();
    if (byTranslation) {
      this.logger.log(`🟢 "${text}" знайдено в БД за перекладом → "${byTranslation.text}"`);
      return { english: byTranslation.text, method: 'db_translation', matchedWord: byTranslation };
    }

    const layout = uaLayoutToEnglish(text);
    if (layout) {
      const layoutWord = await this.wordRepo
        .createQueryBuilder('word')
        .where('LOWER(word.text) = :q', { q: layout })
        .orWhere('word.forms @> ARRAY[CAST(:q AS text)]', { q: layout })
        .orderBy('word.id', 'ASC')
        .getOne();
      if (layoutWord) {
        this.logger.log(`⌨️ Розкладка: "${text}" → "${layout}" (є в словнику)`);
        return { english: layoutWord.text, method: 'keyboard_layout', matchedWord: layoutWord };
      }
      if (!layout.includes(' ') && (isKnownVerbLemma(layout) || classifyClosedClassWord(layout))) {
        this.logger.log(`⌨️ Розкладка: "${text}" → "${layout}" (лексикон)`);
        return { english: layout, method: 'keyboard_layout' };
      }
    }

    const ai = await this.translateUkrainianQueryViaAi(text);
    if (!ai) return null;
    if (layout && this.levenshtein(ai, layout) <= 2) {
      this.logger.warn(`⚠️ AI повернув розкладку замість перекладу для "${text}" → "${ai}". Відхилено.`);
      return null;
    }
    return { english: ai, method: 'ai' };
  }

  private async translateUkrainianQueryViaAi(text: string): Promise<string | null> {
    // Той самий український запит — та сама відповідь: з бази, без ШІ.
    // '' — ШІ вже сказав, що перекласти не можна (теж не питаємо вдруге).
    const cacheKey = `v1:uk-query:${createHash('sha1').update(text.trim().toLowerCase()).digest('hex')}`;
    const cached = await this.aiCache.get<{ english: string }>(cacheKey);
    if (cached) return cached.english || null;

    try {
      this.assertOpenAiAvailable();
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              "You map a learner's dictionary query to an English dictionary headword. The input may be genuine " +
              'Ukrainian (a word or a phrase), English typed with a Ukrainian keyboard layout, or meaningless text.\n' +
              'Rules:\n' +
              '- Genuine Ukrainian -> the most common English headword or phrase with the same meaning, in dictionary ' +
              'form (verbs: bare infinitive without "to"; nouns: singular; phrases: natural English word order). ' +
              'Examples: "машина часу" -> "time machine"; "яблуко" -> "apple"; "здаватися" (припиняти спроби) -> "give up"; ' +
              '"розповідати" -> "tell".\n' +
              '- NEVER transliterate Ukrainian letters into Latin and NEVER return keyboard-layout output.\n' +
              '- If the input is not meaningful Ukrainian, set inputLanguage to "gibberish" and english to "".',
          },
          { role: 'user', content: `Query: «${text}»` },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'uk_query_resolution_v1',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['inputLanguage', 'english', 'confidence'],
              properties: {
                inputLanguage: { type: 'string', enum: ['uk', 'en_layout', 'other', 'gibberish'] },
                english: { type: 'string' },
                confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
              },
            },
          },
        } as any,
      });
      const content = response.choices[0]?.message?.content;
      if (!content) return null;
      const parsed = JSON.parse(content) as { inputLanguage: string; english: string; confidence: string };
      const english = String(parsed.english ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (parsed.inputLanguage !== 'uk' || parsed.confidence === 'low' || !isLatinQuery(english)) {
        this.logger.warn(`Український запит "${text}" не перекладено: ${content}`);
        await this.aiCache.set(cacheKey, 'uk-query', { english: '' });
        return null;
      }
      await this.aiCache.set(cacheKey, 'uk-query', { english });
      return english;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.warn(`Переклад запиту "${text}" провалився: ${(error as Error)?.message}`);
      return null;
    }
  }

  /**
   * Запасна відповідь, коли повний запис не пройшов перевірку: короткий
   * переклад без збереження в БД (id = 0, transient = true). Клієнт показує
   * його, але не пропонує додати в словник.
   */
  /** Короткий переклад слова (у реченні, якщо є) — з кешу або одним запитом. Кидає помилку виклику AI. */
  private async fetchQuickTranslation(query: string, rawContext?: string): Promise<QuickTranslation | null> {
    const context = this.sanitizeContext(rawContext);
    // Запасний переклад того самого слова в тому самому реченні — з бази.
    const quickKey = `v1:quick-translation:${createHash('sha1')
      .update(`${query.trim().toLowerCase()}|${(context ?? '').toLowerCase()}`)
      .digest('hex')}`;
    let parsed: QuickTranslation | null = await this.aiCache.get<QuickTranslation>(quickKey);
    if (!parsed) {
      this.assertOpenAiAvailable();
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You are an English-Ukrainian dictionary. Give the Ukrainian translation of the English word or phrase ' +
              '(1-2 variants separated by " / ", Ukrainian letters only, no explanations). If a sentence is given, ' +
              'translate the sense used in that sentence. If the input is not an existing English word or expression, ' +
              'set isRealEnglishEntry=false and translation="".',
          },
          {
            role: 'user',
            content: context ? `Word: "${query}"\nSentence: «${context}»` : `Word: "${query}"`,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'quick_translation_v1',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['isRealEnglishEntry', 'translation', 'partOfSpeech'],
              properties: {
                isRealEnglishEntry: { type: 'boolean' },
                translation: { type: 'string' },
                partOfSpeech: {
                  type: 'string',
                  enum: ['noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'conjunction', 'interjection', 'numeral', 'none'],
                },
              },
            },
          },
        } as any,
      });
      const content = response.choices[0]?.message?.content;
      parsed = content ? JSON.parse(content) : null;
      if (parsed) await this.aiCache.set(quickKey, 'quick-translation', parsed);
    }
    return parsed;
  }

  private async buildTransientWord(query: string, rawContext?: string): Promise<Word> {
    const notFound = () =>
      new NotFoundException(`Не вдалося знайти переклад для «${query}». Перевірте написання.`);

    let parsed: QuickTranslation | null;
    try {
      parsed = await this.fetchQuickTranslation(query, rawContext);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.warn(`Запасний переклад "${query}" провалився: ${(error as Error)?.message}`);
      throw notFound();
    }

    const translation = String(parsed?.translation ?? '').trim().toLowerCase();
    if (!parsed?.isRealEnglishEntry || validateUkrainianTranslation(translation).length > 0) {
      throw notFound();
    }

    const pos = parsed.partOfSpeech && parsed.partOfSpeech !== 'none' ? (parsed.partOfSpeech as PartOfSpeech) : undefined;
    const transient = this.wordRepo.create({
      text: query.trim().toLowerCase(),
      translation,
      pronunciation: '',
      type: query.trim().includes(' ') ? 'phrase' : 'word',
      partOfSpeech: pos,
      examples: [],
      forms: [],
      description: '',
      definitions: [],
      isProperNoun: false,
    });
    transient.id = 0;
    (transient as Word & { transient?: boolean }).transient = true;
    return transient;
  }

  private async findOrGenerateWord(
    query: string,
    providedPartOfSpeech?: string,
    rawContext?: string,
  ): Promise<Word> {
    const context = this.sanitizeContext(rawContext);
    // Типографський апостроф (don’t) → звичайний, інакше не спрацьовують
    // ні CANONICAL_FORM_OVERRIDES, ні точний пошук.
    query = query.replace(/[’‘]/g, "'");
    // Фраза з "himself / herself / …" записується в нейтральній формі з
    // "oneself" — і шукається в базі теж за нею.
    {
      const neutral = toNeutralReflexivePhrase(query.trim().toLowerCase());
      if (neutral !== query.trim().toLowerCase()) query = neutral;
    }
    let lowerQuery = query.trim().toLowerCase();

    const override = WordGenerationService.CANONICAL_FORM_OVERRIDES[lowerQuery];
    if (override) {
      this.logger.log(`⚡ Перехоплено скорочення на старті: "${lowerQuery}" -> "${override.lemma}"`);
      lowerQuery = override.lemma;
      providedPartOfSpeech = providedPartOfSpeech || override.partOfSpeech;
      query = override.lemma;
    }

    // Присвійна форма ("man's", "Ivan's") — це саме слово: детерміновано,
    // без AI (раніше кожне натискання йшло в gpt-4o). Скорочення
    // займенників ("it's", "he's", "there's", "let's") лишаються як були.
    const possessive = !override ? /^([a-z]{2,40})'s$/.exec(lowerQuery) : null;
    const possessiveBase =
      possessive && !classifyClosedClassWord(possessive[1]) && !NON_POSSESSIVE_S.has(possessive[1])
        ? possessive[1]
        : null;

    // Одне "звичайне" слово (без апострофів, дефісів, не службове): точний
    // розбір форми → значення з урахуванням частини мови та речення.
    // Фрази, скорочення, службові слова й числівники йдуть шляхом нижче
    // без жодних змін.
    const singleWord = possessiveBase ?? lowerQuery;
    if (!override && this.isPlainSingleWord(singleWord)) {
      const resolved = await this.searchOrCreateSingleWord(singleWord, providedPartOfSpeech, context);
      if (resolved) return resolved;
    }

    const { word: existing, keepSurface } = await this.findExistingWord(lowerQuery, context);

    // Пошук нічого не змінює в наявних записах (раніше тут перезаписувалась
    // partOfSpeech за PhraseLibrary під час звичайного тапу).
    if (existing) return existing;

    // ⚡ Бібліотека фраз потрібна лише для генерації нового запису — для вже
    // знайденого слова цей запит у БД був зайвим.
    const libraryMatch = await this.phraseLibraryRepo
      .createQueryBuilder('phraseLib')
      .where('LOWER(phraseLib.surfaceForm) = :query', { query: lowerQuery })
      .getOne();

    this.assertOpenAiAvailable();

    const structure = classifyQueryStructure(query);

    // Форму, яку не можна зводити до іншої леми (training, news, left…),
    // генеруємо саме як її — AI не має права замінити її на train/new/leave.
    if (keepSurface && structure.wordCount === 1 && !structure.isCertain && !structure.lockedLemma) {
      structure.lockedLemma = structure.normalizedQuery;
      structure.reason += '; лему зафіксовано (самостійне або неоднозначне слово)';
    }

    if (libraryMatch && libraryMatch.partOfSpeech) {
      (structure as any).partOfSpeech = libraryMatch.partOfSpeech;
      structure.isCertain = true;
      this.logger.log(`🟢 Знайдено на сервері у PhraseLibrary! partOfSpeech перевизначено на: "${libraryMatch.partOfSpeech}"`);
    } else if (providedPartOfSpeech) {
      (structure as any).partOfSpeech = providedPartOfSpeech;
      structure.isCertain = true;
      this.logger.log(`Отримано partOfSpeech з бази/словника (від клієнта): "${providedPartOfSpeech}". AI не буде визначати його самостійно.`);
    } else {
      this.logger.log(
        `Класифікація "${query}": type=${structure.type}, pos=${structure.partOfSpeech}, ` +
        `certain=${structure.isCertain}. Причина: ${structure.reason}`,
      );
    }

    const deterministicLemma = this.buildDeterministicLemma(structure);

    this.logger.log(`Слово/фразу "${query}" не знайдено в БД. Запускаю генерацію AI...`);

    let creative: CreativeContent;
    try {
      creative = await this.generateCreativeContent(query, structure, deterministicLemma, context);
    } catch (error) {
      if (error instanceof DuplicateLemmaFoundError) {
        this.logger.log(
          `♻️ Рання перевірка виявила, що лема "${error.word.text}" вже існує в базі — ` +
          `повертаю наявний запис без виклику AI на генерацію контенту.`,
        );

        return error.word;
      }

      throw error;
    }

    const finalText = deterministicLemma ?? this.resolveOpenClassLemma(query, creative);
    const aiTextLower = finalText.toLowerCase();

    const duplicateCheck = await this.wordRepo.findOne({
      where: { text: aiTextLower },
      order: { id: 'ASC' },
    });

    if (duplicateCheck) {
      this.logger.warn(`"${aiTextLower}" було згенеровано, але вже існує в БД. Повертаємо існуюче.`);

      return duplicateCheck;
    }

    const finalPartOfSpeech: PartOfSpeech | null = this.resolveFinalPartOfSpeech(
      query,
      aiTextLower,
      structure,
      creative,
    );
    const finalType: WordType = this.resolveFinalType(structure, finalPartOfSpeech);

    const hasKnownHeadVerb = structure.wordCount === 1 ? true : !!structure.headVerbLemma;

    const forms: string[] = this.computeForms(
      finalText,
      finalPartOfSpeech,
      hasKnownHeadVerb,
    );

    const wordData: Partial<Word> = {
      text: aiTextLower,
      translation: String(creative.translation).toLowerCase(),
      pronunciation: creative.pronunciation,
      type: finalType,
      partOfSpeech: finalPartOfSpeech ?? undefined,
      examples: creative.examples,
      level: creative.level === 'none' ? undefined : creative.level,
      forms,
      description: '',
      definitions: [],
      isProperNoun: !!creative.isProperNoun,
    };

    const newWord = this.wordRepo.create(wordData);
    await this.prepareEntryForSave(newWord, creative);

    try {
      const savedWord = await this.wordRepo.save(newWord);

      await Promise.all([
        this.cacheService.clear(WordGenerationService.ALL_WORDS_CACHE_KEY),
        this.cacheService.clear(WordGenerationService.ALL_WORDS_SHORT_CACHE_KEY),
      ]);

      return savedWord;
    } catch (error: any) {
      if (error.code === '23505') {
        const finalWord = await this.wordRepo.findOne({ where: { text: aiTextLower }, order: { id: 'ASC' } });
        if (finalWord) return finalWord;
      }
      throw error;
    }
  }

  async generateBulkPreview(
    texts: string[],
    packageId: number | null,
    forcedPartOfSpeech?: string,
  ): Promise<BulkWordPreviewItem[]> {
    const cleanedTexts = Array.from(
      new Set(texts.map((t) => t.trim()).filter((t) => t.length > 0)),
    ).slice(0, WordGenerationService.MAX_BULK_WORDS);

    const results: BulkWordPreviewItem[] = new Array(cleanedTexts.length);

    for (let i = 0; i < cleanedTexts.length; i += WordGenerationService.BULK_GENERATION_CONCURRENCY) {
      const chunk = cleanedTexts.slice(i, i + WordGenerationService.BULK_GENERATION_CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map((rawText) => this.generateOnePreviewItem(rawText, packageId, forcedPartOfSpeech)),
      );
      chunkResults.forEach((item, idx) => {
        results[i + idx] = item;
      });
    }

    return results;
  }

  private async generateOnePreviewItem(
    rawText: string,
    packageId: number | null,
    forcedPartOfSpeech?: string,
  ): Promise<BulkWordPreviewItem> {
    try {
      const preview = await this.generateSinglePreview(rawText, forcedPartOfSpeech);

      if (preview.existing) {
        return {
          inputText: rawText,
          status: 'duplicate',
          existingWordId: preview.existing.id,
          data: {
            text: preview.existing.text,
            translation: preview.existing.translation,
            pronunciation: preview.existing.pronunciation ?? '',
            type: preview.existing.type as WordType,
            partOfSpeech: preview.existing.partOfSpeech ?? null,
            examples: preview.existing.examples ?? [],
            level: preview.existing.level ?? null,
            forms: preview.existing.forms ?? [],
            description: preview.existing.description ?? '',
            definitions: preview.existing.definitions ?? [],
            packageId,
            isProperNoun: !!(preview.existing as any).isProperNoun,
          },
        };
      }

      return {
        inputText: rawText,
        status: 'generated',
        data: {
          text: preview.data.text as string,
          translation: preview.data.translation as string,
          pronunciation: preview.data.pronunciation as string,
          type: preview.data.type as WordType,
          partOfSpeech: (preview.data.partOfSpeech as string) ?? null,
          examples: preview.data.examples ?? [],
          level: (preview.data.level as string) ?? null,
          forms: preview.data.forms ?? [],
          description: preview.data.description ?? '',
          definitions: preview.data.definitions ?? [],
          packageId,
          isProperNoun: !!(preview.data as any).isProperNoun,
        },
      };
    } catch (error: any) {
      this.logger.error(`Bulk-превʼю: помилка генерації для "${rawText}"`, error);
      return {
        inputText: rawText,
        status: 'error',
        errorMessage: error?.message || 'Невідома помилка генерації',
        data: {
          text: rawText.toLowerCase(),
          translation: '',
          pronunciation: '',
          type: 'word',
          partOfSpeech: null,
          examples: [],
          level: null,
          forms: [],
          description: '',
          definitions: [],
          packageId,
          isProperNoun: false,
        },
      };
    }
  }

  private async generateSinglePreview(
    query: string,
    forcedPartOfSpeech?: string,
  ): Promise<{ existing: Word | null; data: Partial<Word> }> {
    let lowerQuery = query.trim().toLowerCase();

    const override = WordGenerationService.CANONICAL_FORM_OVERRIDES[lowerQuery];
    if (override) {
      lowerQuery = override.lemma;
      forcedPartOfSpeech = forcedPartOfSpeech || override.partOfSpeech;
      query = override.lemma;
    }

    const { word: existing, keepSurface } = await this.findExistingWord(lowerQuery);

    if (existing) {
      return { existing, data: {} };
    }

    this.assertOpenAiAvailable();

    const libraryMatch = await this.phraseLibraryRepo
      .createQueryBuilder('phraseLib')
      .where('LOWER(phraseLib.surfaceForm) = :query', { query: lowerQuery })
      .getOne();

    const structure = classifyQueryStructure(query);

    if (keepSurface && structure.wordCount === 1 && !structure.isCertain && !structure.lockedLemma) {
      structure.lockedLemma = structure.normalizedQuery;
    }

    if (libraryMatch && libraryMatch.partOfSpeech) {
      (structure as any).partOfSpeech = libraryMatch.partOfSpeech;
      structure.isCertain = true;
    } else if (forcedPartOfSpeech) {
      (structure as any).partOfSpeech = forcedPartOfSpeech;
      structure.isCertain = true;
    }

    const deterministicLemma = this.buildDeterministicLemma(structure);

    let creative: CreativeContent;
    try {
      creative = await this.generateCreativeContent(query, structure, deterministicLemma);
    } catch (error) {
      if (error instanceof DuplicateLemmaFoundError) {
        return { existing: error.word, data: {} };
      }
      throw error;
    }

    const finalText = deterministicLemma ?? this.resolveOpenClassLemma(query, creative);
    const aiTextLower = finalText.toLowerCase();

    const duplicateCheck = await this.wordRepo.findOne({ where: { text: aiTextLower }, order: { id: 'ASC' } });
    if (duplicateCheck) {
      return { existing: duplicateCheck, data: {} };
    }

    const finalPartOfSpeech = this.resolveFinalPartOfSpeech(query, aiTextLower, structure, creative);
    const finalType = this.resolveFinalType(structure, finalPartOfSpeech);
    const hasKnownHeadVerb = structure.wordCount === 1 ? true : !!structure.headVerbLemma;

    const forms = this.computeForms(
      finalText,
      finalPartOfSpeech,
      hasKnownHeadVerb,
    );

    const data: Partial<Word> = {
      text: aiTextLower,
      translation: String(creative.translation).toLowerCase(),
      pronunciation: creative.pronunciation,
      type: finalType,
      partOfSpeech: finalPartOfSpeech ?? undefined,
      examples: creative.examples,
      level: creative.level === 'none' ? undefined : creative.level,
      forms,
      description: '',
      definitions: [],
      isProperNoun: !!creative.isProperNoun,
    };

    return { existing: null, data };
  }

  private buildDeterministicLemma(structure: StructureClassification): string | null {
    if (structure.normalizedQuery.includes("'") || structure.normalizedQuery.includes("’")) {
      return null;
    }

    if (structure.lockedLemma) {
      return structure.lockedLemma;
    }

    if (structure.wordCount === 1) {
      if (!structure.isCertain) return null;

      if (structure.headAdjectiveLemma) {
        return structure.headAdjectiveLemma;
      }

      return structure.headVerbLemma ?? structure.normalizedQuery;
    }

    if (structure.headVerbLemma) {
      const words = structure.normalizedQuery.split(' ');
      return [structure.headVerbLemma, ...words.slice(1)].join(' ');
    }

    if (structure.isCertain) {
      return structure.normalizedQuery;
    }

    return null;
  }

  private resolveOpenClassLemma(originalQuery: string, creative: CreativeContent): string {
    // AI не повертає фразу до "himself" — лишається нейтральна форма.
    return toNeutralReflexivePhrase(this.resolveOpenClassLemmaRaw(originalQuery, creative));
  }

  private resolveOpenClassLemmaRaw(originalQuery: string, creative: CreativeContent): string {
    const cleanedQuery = originalQuery.trim().toLowerCase();
    const aiText = String(creative.text ?? originalQuery).toLowerCase().trim();

    const plausible = this.isAcceptedAiLemma(aiText, cleanedQuery);

    if (!plausible) {
      this.logger.warn(
        `⚠️ AI повернув підозрілу/нереальну лему "${aiText}" для запиту "${originalQuery}". ` +
        `Відхиляю AI-результат, повертаю оригінальний запит без змін.`,
      );
      return cleanedQuery;
    }

    return aiText;
  }

  /**
   * Чи приймати лему від AI замість запиту.
   * Фраза з книги (позначена бібліотекою фраз або вручну в адмінці) — це
   * вже готова лема: AI може лише привести слова до словникової форми
   * ("gave up on" → "give up on"), але не має права скоротити чи підмінити
   * фразу. Раніше "sting of offense" зводилось до "sting", а "i'll be free" —
   * до іншого наявного запису, і читач бачив переклад зовсім не того.
   */
  private isAcceptedAiLemma(candidate: string, original: string): boolean {
    const plausible = candidate.includes(' ')
      ? this.isPlausiblePhrase(candidate, original)
      : this.isPlausibleLemma(candidate, original);
    if (!plausible) return false;

    const originalWords = original.trim().split(/\s+/).filter(Boolean).length;
    if (originalWords >= 2 && this.readerTap()) {
      return candidate.trim().split(/\s+/).filter(Boolean).length === originalWords;
    }
    return true;
  }

  private isPlausiblePhrase(candidate: string, original: string): boolean {
    const c = candidate.trim();
    if (!c) return false;
    if (!/^[a-z]+(?:[ '-]+[a-z]+)*$/i.test(c)) return false;

    const cWordCount = c.split(/\s+/).length;
    const oWordCount = original.trim().split(/\s+/).length;

    return Math.abs(cWordCount - oWordCount) <= 1;
  }

  private isPlausibleLemma(candidate: string, original: string): boolean {
    if (!candidate) return false;
    const c = candidate.trim();
    if (c.length === 0) return false;
    if (!/^[a-z](?:[a-z' -]*[a-z])?$/i.test(c)) return false;

    if (c.includes(' ')) return true;

    const o = original.trim().split(' ')[0];
    if (!o) return true;

    if (Math.abs(c.length - o.length) > 4) return false;

    const distance = this.levenshtein(o, c);
    const maxLen = Math.max(o.length, c.length);
    if (maxLen > 0 && distance / maxLen > 0.6 && distance > 3) return false;

    return true;
  }

  private levenshtein(a: string, b: string): number {
    const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp[a.length][b.length];
  }

  private resolveFinalPartOfSpeech(
    query: string,
    textLower: string,
    structure: StructureClassification,
    creative: CreativeContent,
  ): PartOfSpeech | null {
    const rawPos = structure.isCertain ? (structure as any).partOfSpeech : creative.partOfSpeech;

    if (!structure.isCertain) {
      const grammarGarbageRegex = /^(do not|does not|did not|is not|are not|am not|will|shall|it did|he went|she said|i am|you are|they were|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|won't|can't|couldn't|shouldn't|wouldn't|hasn't|haven't|hadn't|mustn't|cannot|could not|should not|would not|has not|have not|had not|must not)$/i;

      if (grammarGarbageRegex.test(query.trim()) || grammarGarbageRegex.test(textLower)) {
        return null;
      }
    }

    if (!rawPos || rawPos === 'none') return null;

    const allowed: PartOfSpeech[] = [
      'noun', 'verb', 'adjective', 'adverb', 'pronoun',
      'preposition', 'conjunction', 'interjection',
      'phrasal_verb', 'phrase', 'numeral',
    ];

    if ((allowed as string[]).includes(rawPos)) {
      return rawPos as PartOfSpeech;
    }

    return null;
  }

  private resolveFinalType(structure: StructureClassification, finalPos: PartOfSpeech | null): WordType {
    const type = resolveEntryType(structure.normalizedQuery, finalPos, structure.type);
    // Правило читалки: кілька слів, виділених у книзі, — завжди фразове
    // дієслово; фрази приходять лише з карток.
    return type === 'phrase' && this.readerTap() ? 'phrasal_verb' : type;
  }

  private computeForms(
    text: string,
    partOfSpeech: PartOfSpeech | null,
    _hasKnownHeadVerb: boolean,
  ): string[] {
    try {
      return computeDegreeForms(text, partOfSpeech);
    } catch (error) {
      this.logger.error(
        `Непередбачена помилка при обчисленні forms для "${text}" (${partOfSpeech})`,
        error as Error,
      );
      return [];
    }
  }

  private buildCreativeContentSchema(needsPartOfSpeechFromAi: boolean, needsTextFromAi: boolean) {
    const properties: Record<string, any> = {
      translation: { type: 'string' },
      pronunciation: { type: 'string' },
      // Схема з maxLength — лише допоміжна підказка для моделі.
      // Реальний ліміт у 32 символи забезпечує isValidExamplesArray()
      // + enforceExampleArrayConstraints() нижче, оскільки strict
      // json_schema режим OpenAI не гарантовано валідує maxLength.
      examples: {
        type: 'array',
        items: { type: 'string', maxLength: WordGenerationService.MAX_EXAMPLE_LENGTH },
        minItems: 6,
        maxItems: 6,
      },
      level: { type: 'string', enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'none'] },
      isProperNoun: {
        type: 'boolean',
        description:
          "true лише якщо 'text' — це власне ім'я людини (ім'я, прізвище, по-батькові), назва бренду/компанії, вигадане ім'я персонажа тощо, яке в англійській мові завжди пишеться з великої літери незалежно від позиції в реченні. false для звичайних слів, дієслів, прикметників, а також для назв країн/національностей/днів тижня/місяців (вони обробляються окремо).",
      },
    };
    properties.isRealEnglishEntry = {
      type: 'boolean',
      description:
        'false, якщо це не існуюче англійське слово, вираз чи власна назва (набір літер, текст іншою мовою, ' +
        'слово, набране не в тій розкладці). Тоді решту полів заповни мінімально.',
    };
    const required = ['translation', 'pronunciation', 'examples', 'level', 'isProperNoun', 'isRealEnglishEntry'];

    if (needsTextFromAi) {
      properties.text = { 
        type: 'string',
        description: "Початкова словникова форма. СУВОРО ЗАБОРОНЕНО використовувати скорочення з апострофами (наприклад, замість didn't завжди пиши did not)."
      };
      required.push('text');
    }

    if (needsPartOfSpeechFromAi) {
      properties.partOfSpeech = {
        type: 'string',
        enum: [
          'noun', 'verb', 'adjective', 'adverb', 'pronoun',
          'preposition', 'conjunction', 'interjection', 'none',
        ],
      };
      required.push('partOfSpeech');
    }

    return {
      name: 'dictionary_word_content',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties,
        required,
      },
    };
  }

  private buildSystemPrompt(needsPartOfSpeechFromAi: boolean, needsTextFromAi: boolean): string {
    const sections: string[] = [];
    let sectionNumber = 1;

    if (needsTextFromAi) {
      sections.push(`${sectionNumber}. "text" — ЗАВЖДИ ПОЧАТКОВА СЛОВНИКОВА ФОРМА (lemma), НІКОЛИ форма з тексту.

  Дієслово (якщо це ОДНЕ слово) → інфінітив без "to".

  Якщо запит — це власне ім'я людини у присвійному відмінку або з іншим
  закінченням (наприклад "Ivan's", "Johns", "Marias") → зведи до чистого
  імені без апострофа/закінчення: "Ivan's" → "Ivan", "Johns" → "John".
  Регістр першої літери імені в цьому полі ЗБЕРІГАЙ як власну назву
  (з великої літери), навіть якщо запит був написаний з малої.

  🔥 КРИТИЧНО ВАЖЛИВО (Розгортання скорочень): СУВОРО ЗАБОРОНЕНО повертати в це поле слова зі скороченнями та апострофами (n't, 'm, 's, 're, 'll, 've) — ОКРІМ присвійного 's при особових іменах, який просто відкидається (див. вище).
  Якщо запит є скороченням дієслова, ОБОВ'ЯЗКОВО розгорни його в повну, граматично правильну форму (без апострофа):
    didn't → did not
    don't → do not
    won't → will not
    isn't → is not
    can't → cannot
    I'm → I am
    you're → you are

  Фразове дієслово або стала фраза/ідіома (якщо запит складається з кількох слів) →
  ЗАВЖДИ зберігай УСІ компоненти та слова фрази у їхній початковій формі!
  СУВОРО ЗАБОРОНЕНО викидати частки, слова або скорочувати фразу до одного головного дієслова.
    write in order to → write in order to
    run away → run away
    in order to → in order to
    is going to → be going to`);
      sectionNumber += 1;
    }

    sections.push(`${sectionNumber}. "translation": 1-2 найточніші переклади українською через " / ".
   Це ЗНАЧЕННЯ слова/фрази, а не те, як воно звучить. Лише українські
   літери, без пояснень у дужках. Усі варіанти — ТІЄЇ САМОЇ частини мови,
   що й слово (дієслово → дієслова, іменник → іменники): НЕ "ходити / прогулянка".
   Для дієслова, якщо в українській є видова пара або пара дієслів руху,
   дай обидва члени: "tell" → "розповідати / розповісти", "walk" → "ходити / йти".
   Якщо "text" — власне ім'я людини (isProperNoun: true), сюди пиши
   транслітерацію імені українською з великої літери (наприклад "Іван").`);
    sectionNumber += 1;

    sections.push(`${sectionNumber}. "pronunciation": Фонологічна транслітерація КИРИЛИЦЕЮ — як ЗВУЧИТЬ БАЗОВА (СЛОВНИКОВА) ФОРМА слова/фрази, записана українськими літерами.
   🔥 КРИТИЧНО ВАЖЛИВО: Транслітеруй САМЕ ту спрощену/початкову форму, яку ти повертаєш у полі "text" (або яка вже є лемою), а НЕ оригінальний запит із закінченнями!
   - Якщо запит "apples", а початкова форма "apple" → pronunciation має бути "епл" (а не "еплз").
   - Якщо запит "worked", а початкова форма "work" → pronunciation має бути "ворк" (а не "воркт").
   - Лише літери українського алфавіту та пробіли. Без дужок/апострофів/спецсимволів.
   - Спрощені відповідники (apple → епл, necktie → нектай).

   🔴 ОБОВ'ЯЗКОВЕ РОЗРІЗНЕННЯ "г" і "ґ" (це РІЗНІ звуки, не взаємозамінні):
   - Твердий проривний англійський звук /g/ (як у "get", "go", "big", "game",
     "dog", "garden") ЗАВЖДИ передавай через "ґ" (з апострофом-хвостиком),
     НІКОЛИ через "г".
     Приклади: get → "ґет", go → "ґоу", big → "біґ", game → "ґейм",
     garden → "ґарден", dog → "доґ".
   - Український "г" (м'який, гортанний) використовуй ЛИШЕ для англійського
     звуку /h/ (як у "hello", "hi", "house", "hand").
     Приклади: hello → "хело", house → "гаус", hand → "генд".
   - НЕ підміняй "ґ" на "г" навіть якщо це виглядає звичніше — це грубо
     спотворює вимову для того, хто вчиться (наприклад "get" НЕ "гет", а "ґет").

   КОНТРАСТНИЙ ПРИКЛАД, щоб не переплутати поля:
     query: "apple"
     translation: "яблуко"   (це ЗНАЧЕННЯ)
     pronunciation: "епл"    (це ЗВУЧАННЯ)`);
    sectionNumber += 1;

    sections.push(`${sectionNumber}. "examples": РІВНО 6 рядків, БЕЗ ВИНЯТКІВ (навіть для фразових дієслів
   чи складних фраз): [0] eng речення 1, [1] укр переклад речення 1,
   [2] eng речення 2, [3] укр переклад речення 2, [4] eng речення 3, [5] укр переклад речення 3.

   🔥🔥 ЖОРСТКЕ ОБМЕЖЕННЯ ДОВЖИНИ (АБСОЛЮТНИЙ ЛІМІТ, НЕ ПОРАДА):
   КОЖЕН з 6 рядків — МАКСИМУМ ${WordGenerationService.MAX_EXAMPLE_LENGTH} СИМВОЛИ, включно з пробілами,
   комами, крапками та будь-якими іншими знаками. Порахуй символи в
   реченні, перш ніж повернути відповідь. Якщо природне речення виходить
   довшим — обов'язково скороти/спрости його (навіть якщо це трохи
   зменшить природність чи стилістичну красу) так, щоб воно все одно
   лишалося логічним, граматично коректним і зрозумілим реченням, а не
   уривком слів. НІКОЛИ не повертай рядок довший за ${WordGenerationService.MAX_EXAMPLE_LENGTH} символів.
   Жоден рядок не може бути порожнім.

   📈 ЗМІСТОВНІСТЬ І СКЛАДНІСТЬ ВІДПОВІДНО ДО РІВНЯ:
   - Речення не примітивні ("I like it", "It is big"), а змістовні й
     природні: з деталлю, обставиною чи причиною (хто, де, коли, навіщо),
     але без громіздкості — використовуй доступний ліміт символів розумно.
   - Складність будови речення відповідає рівню, який ти ставиш у "level":
     A1–A2 — просте речення з однією-двома деталями;
     B1–B2 — складніше: сполучники (because, when, although, so),
       підрядне речення або дієприслівниковий зворот;
     C1–C2 — ще багатша, гармонійна конструкція, природна лексика того ж рівня.
   - Три пари — різні ситуації, без повторення однієї й тієї ж схеми.

   🕒 ЧАСОВА ПРОГРЕСІЯ ПАР РЕЧЕНЬ (обов'язково для кожного слова/фрази):
   - Пара [0]-[1] (перше речення + переклад): ТЕПЕРІШНІЙ час (Present Simple
     або Present Continuous — обери природніший варіант для цього слова).
   - Пара [2]-[3] (друге речення + переклад): МИНУЛИЙ час (Past Simple).
   - Пара [4]-[5] (третє речення + переклад): МАЙБУТНІЙ час (Future Simple
     "will" або конструкція "going to" — обери природніший варіант).
   Кожне з трьох речень має природно демонструвати вживання слова/фрази
   саме в тому граматичному часі, який зазначено для його пари.

   Це поле ОБОВ'ЯЗКОВЕ для будь-якого типу запиту без винятків.
   Якщо "text" — власне ім'я людини, використовуй це ім'я в реченнях
   ТОЧНО з великої літери на початку слова, у БУДЬ-якій позиції речення
   (не лише на початку речення).`);
    sectionNumber += 1;

    sections.push(`${sectionNumber}. "level": CEFR "A1"–"C2", базуй на частотності, не завищуй.
   Для власних імен людей став "A1".`);
    sectionNumber += 1;

    if (needsPartOfSpeechFromAi) {
      sections.push(`${sectionNumber}. "partOfSpeech" — лише одне з переліку:
   noun, verb, adjective, adverb, pronoun, preposition, conjunction, interjection.
   Визнач НАЙЧАСТІШЕ вживане значення цього ОДНОГО слова поза контекстом
   речення. Власні імена людей класифікуй як "noun".`);
      sectionNumber += 1;
    }

    sections.push(`${sectionNumber}. "isRealEnglishEntry" — false, якщо запит НЕ є існуючим англійським
   словом, сталим виразом чи власною назвою (набір літер на кшталт "vfibyf xfce",
   слово іншою мовою, текст у неправильній розкладці). Не вигадуй значення для
   таких запитів і не пиши заглушок у "translation".`);
    sectionNumber += 1;

    sections.push(`${sectionNumber}. "isProperNoun" — true, ТІЛЬКИ якщо "text" є власним ім'ям людини
   (ім'я, прізвище, по-батькові, вигадане ім'я персонажа з книги тощо),
   назвою бренду/компанії чи іншою власною назвою, що ЗАВЖДИ пишеться
   з великої літери в англійській мові незалежно від позиції в реченні.
   false для звичайних слів, дієслів, прикметників, а також для назв
   країн/національностей/мов/днів тижня/місяців — вони обробляються
   окремим механізмом і НЕ мають впливати на це поле.
   Приклади true: "Ivan", "John", "Maria", "Coca-Cola", "Frodo".
   Приклади false: "apple", "run", "happy", "ukrainian", "monday".`);

    return `Ти професійний лінгвіст та укладач словників. Проаналізуй запит користувача
(слово чи фраза можуть бути в БУДЬ-ЯКІЙ граматичній формі — минулий час,
множина, ступінь порівняння тощо) і поверни інформацію у форматі JSON.

════════════════════════════════════════
${sections.join('\n\n════════════════════════════════════════\n')}
════════════════════════════════════════

Жодних полів, крім вказаних вище. Не додавай пояснень поза JSON.`;
  }

  private async generateCreativeContent(
    query: string,
    structure: StructureClassification,
    deterministicLemma: string | null,
    context?: string,
  ): Promise<CreativeContent> {
    const needsPartOfSpeechFromAi = !structure.isCertain;
    const needsTextFromAi = deterministicLemma === null;

    let correctedLemma: string;
    let resolvedPartOfSpeech: string | undefined;

    if (!needsTextFromAi) {
      correctedLemma = deterministicLemma!;
      resolvedPartOfSpeech = undefined;
    } else {
      const isMultiWord = query.trim().split(/\s+/).length > 1;

      const { text: rawLemma, partOfSpeech: rawPartOfSpeech, phraseType } =
        await this.resolveLemmaViaAi(query, needsPartOfSpeechFromAi, isMultiWord, context);

      if (isMultiWord && phraseType) {
        structure.type = phraseType;
        (structure as any).partOfSpeech = phraseType === 'phrasal_verb' ? 'phrasal_verb' : 'idiom';
      }

      const cleanedQuery = query.trim().toLowerCase();
      const rawLemmaTrimmed = String(rawLemma ?? cleanedQuery).toLowerCase().trim();

      const rawIsPlausible = this.isAcceptedAiLemma(rawLemmaTrimmed, cleanedQuery);

      if (!rawIsPlausible) {
        this.logger.warn(
          `⚠️ AI повернув підозрілу/нереальну лему "${rawLemmaTrimmed}" для запиту "${query}". ` +
          `Відхиляю AI-результат, використовую оригінальний запит як лему.`,
        );
        correctedLemma = cleanedQuery;
        resolvedPartOfSpeech = rawPartOfSpeech;
      } else {
        correctedLemma = toNeutralReflexivePhrase(rawLemmaTrimmed);
        resolvedPartOfSpeech = rawPartOfSpeech;
      }
    }

    const override = WordGenerationService.CANONICAL_FORM_OVERRIDES[correctedLemma];
    if (override) {
      this.logger.log(
        `🔁 Застосовую явний override канонічної форми: "${correctedLemma}" -> ` +
        `"${override.lemma}" (${override.partOfSpeech}). Це детермінований запис у словнику, а не здогадка AI.`,
      );
      correctedLemma = override.lemma;
      resolvedPartOfSpeech = override.partOfSpeech;
    }

    const earlyDuplicate = await this.wordRepo.findOne({
      where: { text: correctedLemma.toLowerCase() },
      order: { id: 'ASC' },
    });
    if (earlyDuplicate) {
      throw new DuplicateLemmaFoundError(earlyDuplicate);
    }

    const stillNeedsPartOfSpeechFromAi = needsTextFromAi ? false : needsPartOfSpeechFromAi;

    // Одне слово з детерміновано відомою частиною мови (прийменник, модальне
    // дієслово, числівник…): переклад саме для неї — інакше "like"
    // (прийменник) отримував переклад дієслова "подобатися", а "will" —
    // "воля". Лише якщо частина мови однозначна: "but", "for", "that"
    // бувають і прийменником, і сполучником, і займенником. Речення не
    // передаємо: переклад службового слова спільний для всіх речень.
    // Фрази цього не стосується.
    const knownPos = (structure as any).partOfSpeech as string | undefined;
    // will/can/must — модальні: "will" як просто "verb" отримував "бажати".
    const senseLabel =
      classifyClosedClassWord(structure.normalizedQuery) === 'modal_verb' ? 'modal verb (модальне дієслово)' : knownPos;
    const singleWordSense =
      structure.wordCount === 1 &&
      structure.isCertain &&
      knownPos &&
      knownPos !== 'none' &&
      !isMultiClassFunctionWord(structure.normalizedQuery)
        ? { partOfSpeech: senseLabel }
        : undefined;

    return this.generateContentForKnownLemma(
      correctedLemma,
      stillNeedsPartOfSpeechFromAi,
      resolvedPartOfSpeech,
      singleWordSense,
    );
  }

  private async resolveLemmaViaAi(
    query: string,
    needsPartOfSpeech: boolean,
    isMultiWord: boolean = false,
    context?: string,
  ): Promise<{ text: string; partOfSpeech?: string; phraseType?: 'phrasal_verb' | 'idiom' | 'fixed_expression' }> {
    this.assertOpenAiAvailable();

    const properties: Record<string, any> = {
      text: { 
        type: 'string',
        description: "Початкова словникова форма. СУВОРО ЗАБОРОНЕНО використовувати скорочення з апострофами (наприклад, замість didn't завжди пиши did not). Для присвійної форми особового імені (напр. \"Ivan's\") — поверни саме ім'я без апострофа і закінчення (\"Ivan\")."
      },
    };
    const required = ['text'];

    if (needsPartOfSpeech) {
      properties.partOfSpeech = {
        type: 'string',
        enum: [
          'noun', 'verb', 'adjective', 'adverb', 'pronoun',
          'preposition', 'conjunction', 'interjection', 'none',
        ],
      };
      required.push('partOfSpeech');
    }

    if (isMultiWord) {
      properties.phraseType = {
        type: 'string',
        enum: ['phrasal_verb', 'idiom', 'fixed_expression'],
      };
      required.push('phraseType');
    }

    const schema = {
      name: 'dictionary_lemma_resolution',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties,
        required,
      },
    };

    const systemPrompt = `Ти професійний лінгвіст. Твоя ЄДИНА задача — звести запит користувача
(слово чи фраза можуть бути в БУДЬ-ЯКІЙ граматичній формі — минулий час,
множина, ступінь порівняння тощо, включно з присвійною формою особових
імен на кшталт "Ivan's") до його ПОЧАТКОВОЇ СЛОВНИКОВОЇ ФОРМИ (lemma).

"text" — ЗАВЖДИ ПОЧАТКОВА СЛОВНИКОВА ФОРМА, НІКОЛИ форма із запиту.

  Дієслово (якщо це ОДНЕ слово) → інфінітив без "to".

  Якщо запит — присвійна форма особового імені ("Ivan's", "Marias",
  "John's") → поверни саме ім'я без апострофа/закінчення: "Ivan's" → "Ivan".

  🔥 КРИТИЧНО ВАЖЛИВО (розгортання скорочень): СУВОРО ЗАБОРОНЕНО залишати слова з апострофами (n't, 'm, 're, 'll, 've) — окрім присвійного 's при особових іменах, який просто відкидається.
  Якщо запит є скороченням дієслова, ОБОВ'ЯЗКОВО розгорни його в повну форму:
    didn't → did not
    don't → do not
    won't → will not
    isn't → is not
    can't → cannot
    I'm → I am
    you're → you are

  Фразове дієслово або стала фраза/ідіома (кілька слів) →
  ГОЛОВНЕ ДІЄСЛОВО (перше слово) ЗАВЖДИ зводь до базової словникової форми
  (як для одного слова вище), а решту слів фрази (частки, прийменники,
  займенники) залишай БЕЗ ЗМІН — вони не відмінюються:
    depends on → depend on   (НЕ "depends on", "s" на кінці головного
                               дієслова треба прибрати!)
    gives up → give up
    runs away → run away
    looked after → look after
    write in order to → write in order to   (write вже в базовій формі)
    in order to → in order to                (тут немає дієслова)
    is going to → be going to                (is → be, "going to" не чіпаємо)
  СУВОРО ЗАБОРОНЕНО викидати частки або слова фрази, і СУВОРО ЗАБОРОНЕНО
  скорочувати фразу до одного головного дієслова.
${needsPartOfSpeech ? `
"partOfSpeech" — лише одне з переліку:
  noun, verb, adjective, adverb, pronoun, preposition, conjunction, interjection.
  Визнач НАЙЧАСТІШЕ вживане значення цього ОДНОГО слова поза контекстом речення.
  Особові імена завжди "noun".
` : ''}${isMultiWord ? `
"phraseType" — СТРОГО одне з трьох, за чіткими критеріями (не вгадуй "на око"):
  - "phrasal_verb": дієслово + частка (up/down/on/off/out/away/back тощо),
    які РАЗОМ утворюють НОВЕ значення, відмінне від суми частин. Тест: чи
    можна замінити ОДНИМ дієсловом-синонімом? "give up" = "quit"/"abandon"
    → так, це phrasal_verb. "look at" = просто "дивитись на" (буквальне
    значення дієслова + прийменник) → це НЕ phrasal_verb, а звичайне
    дієслово з прийменником (класифікуй як "fixed_expression").
    Приклади phrasal_verb: give up, look after, run into, come across,
    figure out, put off, break down, carry on.
  - "idiom": стала образна конструкція, значення якої НЕ виводиться з
    прямого значення жодного зі слів окремо (метафора/образ).
    Приклади: kick the bucket, break the ice, once in a blue moon,
    piece of cake, spill the beans.
  - "fixed_expression": будь-яка інша стала фраза БЕЗ образного/ідіоматичного
    зсуву значення — прийменникові звороти, сталі граматичні конструкції,
    дієслово+прийменник із буквальним значенням.
    Приклади: in order to, as well as, by the way (це радше idiom, обери
    ідіому якщо є образний зсув), look at, wait for, depend on.
` : ''}
Поверни ЛИШЕ JSON із вказаними полями. Жодних пояснень поза JSON.`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: context
              ? `Зведи цей запит до словникової форми: "${query}"\n` +
                `Слово взято з речення: «${context}». Обери лему для значення САМЕ в цьому реченні: ` +
                `якщо тут це окремий іменник чи прикметник (напр. "The training was hard" → "training", ` +
                `"I am tired" → "tired", "turn left" → "left"), НЕ зводь його до дієслова.`
              : `Зведи цей запит до словникової форми: "${query}"`,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: schema,
        } as any,
        temperature: 0,
      });

      const content = response.choices[0].message.content;
      if (!content) {
        throw new InternalServerErrorException('AI повернув порожню відповідь при визначенні леми');
      }

      return JSON.parse(content) as { text: string; partOfSpeech?: string; phraseType?: 'phrasal_verb' | 'idiom' | 'fixed_expression' };
    } catch (error) {
      this.handleOpenAiError(error, `resolveLemmaViaAi("${query}")`);
    }
  }

  private isValidExamplesArray(examples: unknown): examples is string[] {
    return Array.isArray(examples)
      && examples.length === 6
      && examples.every((e) => isWithinExampleLimit(e, WordGenerationService.MAX_EXAMPLE_LENGTH));
  }

  /**
   * Виконує запит на картку слова потоком (stream: true) і повертає ПОВНИЙ
   * текст відповіді — той самий, що й без потоку. Щойно в потоці закрився
   * рядок "translation", викликає onTranslation (один раз, лише з коректним
   * українським перекладом).
   */
  private async createContentStreaming(
    request: Record<string, any>,
    onTranslation: (translation: string) => void,
  ): Promise<string | null> {
    // Таймаут SDK діє лише до заголовків відповіді — для потоку обмежуємо весь
    // запит тими самими 30 с, щоб завислий потік не тримав тап без кінця.
    const stream: any = await this.openai.chat.completions.create(
      { ...(request as any), stream: true },
      { signal: AbortSignal.timeout(WordGenerationService.OPENAI_TIMEOUT_MS) },
    );
    // Відповідь без потоку (наприклад, у тестах) — як і раніше.
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      return stream?.choices?.[0]?.message?.content ?? null;
    }

    let text = '';
    let announced = false;
    for await (const chunk of stream) {
      const delta: unknown = chunk?.choices?.[0]?.delta?.content;
      if (typeof delta !== 'string' || delta.length === 0) continue;
      text += delta;
      if (announced) continue;
      const translation = extractStreamedTranslation(text);
      if (translation === null) continue;
      announced = true;
      if (validateUkrainianTranslation(translation).length === 0) {
        try {
          onTranslation(translation);
        } catch (error) {
          this.logger.warn(`Ранній розбір форми не запущено: ${(error as Error)?.message}`);
        }
      }
    }
    return text || null;
  }

  private async requestCreativeContentWithRetry(
    systemPrompt: string,
    userMessageContent: string,
    schema: any,
    onTranslation?: (translation: string) => void,
  ): Promise<CreativeContent> {
    this.assertOpenAiAvailable();

    let lastParsed: CreativeContent | null = null;

    for (let attempt = 1; attempt <= WordGenerationService.MAX_CONTENT_GENERATION_ATTEMPTS; attempt++) {
      const request = {
        model: 'gpt-4o',
        messages: [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: userMessageContent },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: schema,
        } as any,
        temperature: 0,
      };
      let response: any;
      let content: string | null | undefined;
      try {
        // Той самий запит; з onTranslation відповідь читається потоком, щоб
        // переклад леми (перше поле схеми) був доступний до кінця генерації.
        if (onTranslation) content = await this.createContentStreaming(request, onTranslation);
        else response = await this.openai.chat.completions.create(request);
      } catch (error) {
        this.handleOpenAiError(error, 'requestCreativeContentWithRetry');
      }
      if (!onTranslation) content = response.choices[0].message.content;

      if (!content) {
        this.logger.warn(`⚠️ Спроба ${attempt}/${WordGenerationService.MAX_CONTENT_GENERATION_ATTEMPTS}: AI повернув порожню відповідь.`);
        continue;
      }

      const parsed = JSON.parse(content) as CreativeContent;
      parsed.pronunciation = stripTrailingPeriod(parsed.pronunciation ?? '');
      parsed.examples = (parsed.examples ?? []).map(stripTrailingPeriod);
      if (parsed.text) parsed.text = stripTrailingPeriod(parsed.text);
      lastParsed = parsed;

      // Модель сама каже, що такого англійського слова немає ("vfibyf xfce") —
      // повтор не допоможе, нічого не зберігаємо.
      if (parsed.isRealEnglishEntry === false) {
        // Слово з речення книги — воно існує в тексті (ім'я, сленг, вигадане
        // слово): не відкидаємо, поля, що не пройдуть перевірку, будуть
        // відремонтовані перед збереженням (prepareEntryForSave).
        if (!this.readerTap()) {
          throw new GenerationRejectedError(parsed.text ?? '', ['model_not_real_entry']);
        }
        this.logger.warn(`🩹 Модель вважає "${parsed.text ?? ''}" не словом, але воно є в тексті книги — не відкидаю`);
      }

      const translationProblems = validateUkrainianTranslation(parsed.translation);
      if (translationProblems.length > 0) {
        this.logger.warn(
          `⚠️ Спроба ${attempt}/${WordGenerationService.MAX_CONTENT_GENERATION_ATTEMPTS}: некоректний переклад ` +
          `"${parsed.translation}" (${translationProblems.join(', ')}).`,
        );
        continue;
      }

      if (this.isValidExamplesArray(parsed.examples)) {
        return parsed;
      }

      const examplesValue: unknown = parsed.examples;
      const examplesCount = Array.isArray(examplesValue) ? examplesValue.length : null;
      const overLimitCount = Array.isArray(examplesValue)
        ? examplesValue.filter((e) => typeof e === 'string' && e.trim().length > WordGenerationService.MAX_EXAMPLE_LENGTH).length
        : 0;

      this.logger.warn(
        `⚠️ Спроба ${attempt}/${WordGenerationService.MAX_CONTENT_GENERATION_ATTEMPTS}: AI повернув некоректний масив examples ` +
        `(отримано ${examplesCount ?? 'не масив'} елементів замість 6; з них ${overLimitCount} довших за ${WordGenerationService.MAX_EXAMPLE_LENGTH} символів). ` +
        (attempt < WordGenerationService.MAX_CONTENT_GENERATION_ATTEMPTS ? 'Повторюю запит...' : 'Спроби вичерпано.'),
      );
    }

    if (lastParsed) {
      const translationProblems = validateUkrainianTranslation(lastParsed.translation);
      if (translationProblems.length > 0) {
        // Тап у книзі: переклад відремонтує prepareEntryForSave (окремий
        // запит перекладу в цьому реченні) — слово не відкидається.
        if (!this.readerTap()) {
          throw new GenerationRejectedError(lastParsed.text ?? '', translationProblems);
        }
        this.logger.warn(
          `🩹 Переклад "${lastParsed.translation}" не пройшов перевірку (${translationProblems.join(', ')}) — буде відремонтовано`,
        );
      }
      if (this.isValidExamplesArray(lastParsed.examples)) return lastParsed;

      // Обрізаємо задовгі приклади; якщо якогось бракує (порожній рядок),
      // запис відхилить assertEntryValid перед збереженням.
      const safeExamples = enforceExampleArrayConstraints(
        lastParsed.examples,
        WordGenerationService.MAX_EXAMPLE_LENGTH,
      );

      this.logger.error(
        `❌ Після ${WordGenerationService.MAX_CONTENT_GENERATION_ATTEMPTS} спроб AI так і не повернув приклади, що повністю відповідають ` +
        `вимогам (рівно 6 рядків, кожен ≤${WordGenerationService.MAX_EXAMPLE_LENGTH} символів). Застосовую примусове обрізання як аварійний ` +
        `запобіжник — краще коротший/неідеальний приклад, ніж повний збій генерації слова.`,
      );

      lastParsed.examples = safeExamples.map(stripTrailingPeriod);
      return lastParsed;
    }

    throw new GenerationRejectedError('', ['empty_ai_response']);
  }

  private async generateContentForKnownLemma(
    lemma: string,
    needsPartOfSpeechFromAi: boolean,
    alreadyResolvedPartOfSpeech?: string,
    sense?: { partOfSpeech?: string; context?: string },
    onTranslation?: (translation: string) => void,
  ): Promise<CreativeContent> {
    const schema = this.buildCreativeContentSchema(needsPartOfSpeechFromAi, false);
    const systemPrompt = this.buildSystemPrompt(needsPartOfSpeechFromAi, false);

    let userMessageContent =
      `Згенеруй словникові дані (переклад, транскрипцію, приклади, рівень` +
      `${needsPartOfSpeechFromAi ? ', частину мови' : ''}) для англійського слова/фрази ` +
      `у словниковій формі: "${lemma}". Це вже фінальна базова форма — генеруй усе саме для неї.`;

    // Значення конкретної частини мови (омоніми: "train" — поїзд / тренувати):
    // переклад і приклади мають бути САМЕ для неї, а перший варіант
    // перекладу — відповідати реченню, з якого прийшло слово.
    if (sense?.partOfSpeech) {
      userMessageContent +=
        `\nЧастина мови: ${sense.partOfSpeech}. Переклад, приклади і рівень — ЛИШЕ для значення цієї частини мови ` +
        `(наприклад, для "train" як verb — "тренувати / тренуватися", а не "поїзд"). ` +
        `У всіх прикладах "${lemma}" має бути вжито саме як ${sense.partOfSpeech}.`;
    }
    if (sense?.context) {
      userMessageContent +=
        `\nСлово трапилось у реченні: «${sense.context}». Запис словника спільний для всіх текстів, тому ПЕРШИМ ` +
        `дай найпоширеніший переклад цієї частини мови; якщо в реченні значення інше — додай його другим ` +
        `варіантом через " / ". Приклади склади власні, не копіюй речення.`;
    }

    const parsed = await this.requestCreativeContentWithRetry(systemPrompt, userMessageContent, schema, onTranslation);

    parsed.text = lemma;

    if (alreadyResolvedPartOfSpeech && !parsed.partOfSpeech) {
      parsed.partOfSpeech = alreadyResolvedPartOfSpeech;
    }

    return parsed;
  }
}

/** Поверхнева копія сутності зі збереженням прототипу (і власних прапорців на кшталт transient). */
function cloneEntity<T extends object>(entity: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(entity)), entity);
}

type FormTranslationOutcome = { ok: true; translation: string | null } | { ok: false };

/** Чому переклад форми не годиться; порожній масив — можна зберігати. */
export function formTranslationProblems(translation: string): string[] {
  const reasons: string[] = [];
  if (!translation) return ['empty'];
  if (!/[а-щьюяєіїґ]/i.test(translation)) reasons.push('not_ukrainian');
  if (/[a-z]/i.test(translation)) reasons.push('has_latin');
  if (translation.length > 60) reasons.push('too_long');
  const variants = translation.split(/\s*\/\s*/).filter(Boolean);
  if (variants.length > 2) reasons.push('too_many_variants');
  if (variants.some(v => v.trim().split(/\s+/).length > 3)) reasons.push('not_single_word');
  return reasons;
}

/**
 * Значення "translation" з частково отриманого JSON відповіді, щойно рядок
 * повністю закрився; null — ще не надійшло. Ключ шукається лише на рівні
 * JSON-синтаксису (після "{" або ","), тож текст усередині прикладів, де лапки
 * екрановані, хибно не спрацює.
 */
export function extractStreamedTranslation(partialJson: string): string | null {
  const match = /[{,]\s*"translation"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(partialJson);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return null;
  }
}

type QuickTranslation = { isRealEnglishEntry: boolean; translation: string; partOfSpeech: string };

/** Задовгий переклад: лишаємо перші варіанти (через " / "), що вміщуються в 120 символів. */
function shortenTranslation(value: string, limit = 120): string {
  const variants = value.split(/\s*\/\s*/).map(v => v.trim()).filter(Boolean);
  let out = '';
  for (const variant of variants) {
    const next = out ? `${out} / ${variant}` : variant;
    if (next.length > limit) break;
    out = next;
  }
  if (out) return out;
  const cut = value.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
}
