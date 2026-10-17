import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  InternalServerErrorException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DeleteResult,
  ILike,
  In,
  Raw,
  Repository,
  UpdateResult,
} from 'typeorm';
import { Word, PartOfSpeech } from './word.entity';
import { UserWord, StudyStatus, DictionarySourceType } from './user-word.entity';
import { User } from 'src/user/user.entity';
import { CreateWordDto, WordProgressItemDto } from './word-dto';
import { parseLevelsFilter } from './level-filter.util';
import {
  assertDictionaryCapacity,
  DictionaryCapacity,
  DictionaryLimitReachedException,
  loadDictionaryCapacity,
} from './dictionary-capacity';
import { computeDegreeForms } from './words-details/degree-forms';
import { CacheService } from 'src/cache/cache.service';
import { UserWordProgressService } from 'src/user-word-progress/UserWordProgressService';
import { UserWordProgress, StudyStatus as ProgramStudyStatus } from 'src/user-word-progress/user-word-progress.entity';
import { ProgramPackage } from 'src/program/entities/program-package.entity';
import { SurfaceAnalysis, WordGenerationService } from './words-details/word-generation.service';
import { buildVerbForms, isAuxiliaryInVerbGroup, normalizeLookupQuery, withoutIngForms } from './words-details/reader-lookup.util';
import { computeExampleHighlights } from './example-highlight.util';
import { UserProgramAccess } from 'src/program/entities/program-access.entity';
import { DailyLimitService } from 'src/daily-limit/daily-limit.service';
import { SpellCorrectionService } from './spell-correction.service';
import { WordLookupReport } from './word-lookup-report.entity';

type WordWithUserTranslation = Word & {
  userTranslation: string | null;
  userText: string | null;
};

export interface ProgressBatchResult {
  success: boolean;
  updatedIds: number[];
  failedIds: number[];
}

interface ProgressQueueItem {
  userId: number;
  words: WordProgressItemDto[];
  resolve: (value: ProgressBatchResult) => void;
  reject: (reason: unknown) => void;
}

interface ActiveProgramType {
  packageIds: number[];
  total: number;
  learned: number;
}

interface CategoryCounts {
  total: number;
  learned: number;
  remaining: number;
}

interface WordIdPool {
  byPos: Record<string, number[]>;
  phraseIds: number[];
}

export interface WordCorrectionInfo {
  original: string;
  applied: string;
  method: 'normalize' | 'keyboard_layout' | 'common_typo' | 'db_fuzzy' | 'ai';
  confidence: number;
}

export type WordPatternMode = 'starts_with' | 'contains' | 'exact';

export interface DictionaryFilters {
  bookIds: number[];
  packages: boolean;
  manual: boolean;
  favoritesOnly: boolean;
  /** Рівні слів (word.level); порожньо — усі рівні. */
  levels?: string[];
}

export interface DictionarySource {
  type: DictionarySourceType;
  bookId?: number;
  bookTitle?: string;
  /** Речення з книги, з якого додано слово. */
  sentence?: string;
  /** Форма слова в тексті ("trained" для запису "train"). */
  surface?: string;
}

const clip = (value: string | undefined | null, max: number): string | null => {
  const v = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return v ? v.slice(0, max) : null;
};


/**
 * Слово ще не вивчене: ні в прогресі програми (картки, Dictionary Cards пишуть
 * туди), ні в особистому словнику. Раніше пул карток дивився лише на словник,
 * тож слова, вивчені в картках без додавання в словник, поверталися знову.
 */
const NOT_LEARNED_SQL = `NOT EXISTS (
    SELECT 1 FROM "user_word_progress" uwp
    WHERE uwp."wordId" = word.id AND uwp."userId" = :userId AND uwp."status" = :learnedStatus
  ) AND NOT EXISTS (
    SELECT 1 FROM "user_word" uwd
    WHERE uwd."wordId" = word.id AND uwd."userId" = :userId AND uwd."status" = :learnedStatus
  )`;

const PROGRESS_QUEUE_FLUSH_MS = 150;
const PROGRESS_QUEUE_MAX_SIZE = 500;

@Injectable()
export class WordService implements OnModuleInit, OnModuleDestroy {
  public static readonly ALL_WORDS_CACHE_KEY = 'words:all2';
  public static readonly ALL_WORDS_SHORT_CACHE_KEY = 'words:all2-short';
  public static readonly GLOBAL_TOTAL_WORDS_CACHE_KEY = 'words:global-total-count';
  private readonly GLOBAL_STATS_TTL = 60 * 2;

  private getWordByIdCacheKey = (id: number) => `word:${id}`;
  private getWordByTextCacheKey = (text: string) => `word:text:${text}`;
  private getLastLookupCacheKey = (userId: number, text: string) =>
    `user:${userId}:last-lookup:${text.trim().toLowerCase()}`;

  private readonly progressQueue = new Map<number, ProgressQueueItem[]>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly logger = new Logger(WordService.name);

  private readonly POS_PRIORITY: PartOfSpeech[] = [
    'noun', 'verb', 'adjective', 'adverb',
    'pronoun', 'preposition', 'conjunction', 'interjection',
  ];

  private readonly BATCH_SIZE = 9;
  private readonly ITEMS_PER_CALL = 3;

  private readonly ACTIVE_TYPE_TTL = 60 * 5;
  private readonly ID_POOL_TTL = 60 * 5;
  private readonly TOTAL_COUNT_TTL = 60 * 30;
  private readonly BATCH_TTL = 60 * 3;
  private readonly RECENT_SHOWN_MAX = 18;

  private readonly SRS_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30];
  private readonly SRS_MAX_LEVEL = this.SRS_INTERVAL_DAYS.length - 1;
  // Коли слово в повторенні позначили "не знаю" — не ставимо nextReviewAt
  // рівно "зараз" (інакше воно одразу ж знову вважається due і може
  // вилізти в наступній же пачці). Невеликий кулдаун відсуває його в
  // групу "ще не due", і воно повернеться трохи пізніше, а не одразу.
  private readonly WRONG_ANSWER_COOLDOWN_MS = 5 * 60 * 1000;

 constructor(
    @InjectRepository(Word)
    private readonly wordRepo: Repository<Word>,
    @InjectRepository(UserWord)
    private readonly userWordRepo: Repository<UserWord>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(ProgramPackage)
    private readonly programRepo: Repository<ProgramPackage>,
    @InjectRepository(UserProgramAccess)
    private readonly programAccessRepo: Repository<UserProgramAccess>,
    private readonly cacheService: CacheService,
    private readonly userWordProgressService: UserWordProgressService,
    private readonly wordGenService: WordGenerationService,
    private readonly dailyLimitService: DailyLimitService,
    private readonly spellCorrectionService: SpellCorrectionService,
  ) {}

  async getGlobalWordStats(userId: number): Promise<{ totalWords: number; learnedWords: number }> {
    let totalWords = await this.cacheService.get<number>(WordService.GLOBAL_TOTAL_WORDS_CACHE_KEY);
    if (totalWords === undefined || totalWords === null) {
      totalWords = await this.wordRepo.count();
      await this.cacheService.set(
        WordService.GLOBAL_TOTAL_WORDS_CACHE_KEY,
        totalWords,
        this.TOTAL_COUNT_TTL,
      );
    }

    const learnedKey = `user:${userId}:global-learned-count`;
    let learnedWords = await this.cacheService.get<number>(learnedKey);
    if (learnedWords === undefined || learnedWords === null) {
      learnedWords = await this.userWordRepo.count({
        where: { user: { id: userId }, status: StudyStatus.LEARNED },
      });
      await this.cacheService.set(learnedKey, learnedWords, this.GLOBAL_STATS_TTL);
    }

    return { totalWords, learnedWords };
  }

  onModuleInit() {
    this.logger.log('WordService initialized. Progress queue is ready.');
  }

  // Повертаємо проміс: Nest дочекається дозапису черги ДО закриття
  // з'єднань з БД (TypeORM закривається вже в onApplicationShutdown).
  async onModuleDestroy() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushProgressQueue().catch((err) =>
      this.logger.error('Failed to flush progress queue on shutdown', err),
    );
  }

  enqueueProgressUpdate(
    userId: number,
    words: WordProgressItemDto[],
  ): Promise<ProgressBatchResult> {
    return new Promise((resolve, reject) => {
      const item: ProgressQueueItem = { userId, words, resolve, reject };

      const existing = this.progressQueue.get(userId) ?? [];
      existing.push(item);
      this.progressQueue.set(userId, existing);

      const totalQueued = [...this.progressQueue.values()].reduce(
        (sum, arr) => sum + arr.length,
        0,
      );

      if (totalQueued >= PROGRESS_QUEUE_MAX_SIZE) {
        if (this.flushTimer) {
          clearTimeout(this.flushTimer);
          this.flushTimer = null;
        }
        this.flushProgressQueue();
      } else {
        if (!this.flushTimer) {
          this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flushProgressQueue();
          }, PROGRESS_QUEUE_FLUSH_MS);
        }
      }
    });
  }

  async previewWordsForPackageAssignment(
    texts: string[],
  ): Promise<{
    found: { id: number; text: string; currentPackageId: number | null }[];
    notFound: string[];
  }> {
    const cleanTexts = (texts || [])
      .map((t) => t?.trim().toLowerCase())
      .filter((t): t is string => !!t);

    const uniqueTexts = [...new Set(cleanTexts)];

    if (uniqueTexts.length === 0) {
      throw new BadRequestException('Список слів порожній');
    }

    // Списки текстів (адмінка) стосуються основного значення слова.
    const foundWords = await this.wordRepo.find({
      where: { text: In(uniqueTexts), senseKey: '' },
    });

    const foundByText = new Map(foundWords.map((w) => [w.text.toLowerCase(), w]));

    const found = foundWords.map((w) => ({
      id: w.id,
      text: w.text,
      currentPackageId: w.packageId ?? null,
    }));

    const notFound = uniqueTexts.filter((t) => !foundByText.has(t));

    return { found, notFound };
  }

  async bulkAssignPackageByTexts(
    texts: string[],
    packageId: number,
  ): Promise<{
    success: boolean;
    updatedCount: number;
    notFoundCount: number;
    notFound: string[];
    message: string;
  }> {
    const cleanTexts = (texts || [])
      .map((t) => t?.trim().toLowerCase())
      .filter((t): t is string => !!t);

    const uniqueTexts = [...new Set(cleanTexts)];

    if (uniqueTexts.length === 0) {
      throw new BadRequestException('Список слів порожній');
    }

    this.logger.warn(
      `ADMIN: Bulk assigning packageId=${packageId} to ${uniqueTexts.length} words by text list`,
    );

    const foundWords = await this.wordRepo.find({
      where: { text: In(uniqueTexts), senseKey: '' },
    });

    if (foundWords.length === 0) {
      return {
        success: true,
        updatedCount: 0,
        notFoundCount: uniqueTexts.length,
        notFound: uniqueTexts,
        message: 'Жодного слова зі списку не знайдено в базі',
      };
    }

    const foundByText = new Map(foundWords.map((w) => [w.text.toLowerCase(), w]));
    const notFound = uniqueTexts.filter((t) => !foundByText.has(t));
    const wordIds = foundWords.map((w) => w.id);

    await this.wordRepo.update({ id: In(wordIds) }, { packageId: packageId ?? null });

    await Promise.all([
      ...foundWords.map((w) => this.cacheService.clear(this.getWordByIdCacheKey(w.id))),
      ...foundWords.map((w) => this.cacheService.clear(this.getWordByTextCacheKey(w.text))),
      this.cacheService.clear(WordService.ALL_WORDS_CACHE_KEY),
      this.cacheService.clear(WordService.ALL_WORDS_SHORT_CACHE_KEY),
      this.cacheService.clearByPattern('user:*:words:*'),
      this.cacheService.clearByPattern('user:*:id-pool:*'),
      this.cacheService.clearByPattern('program:*:word-order'),
    ]);

    this.logger.log(
      `ADMIN: Successfully assigned packageId=${packageId} to ${foundWords.length} words, notFound=${notFound.length}`,
    );

    return {
      success: true,
      updatedCount: foundWords.length,
      notFoundCount: notFound.length,
      notFound,
      message: `Успішно оновлено packageId для ${foundWords.length} слів${notFound.length > 0 ? ` (не знайдено: ${notFound.length})` : ''}`,
    };
  }

  private async flushProgressQueue(): Promise<void> {
    if (this.progressQueue.size === 0) return;

    const snapshot = new Map(this.progressQueue);
    this.progressQueue.clear();

    const flushPromises = [...snapshot.entries()].map(([userId, items]) =>
      this.processBatchForUser(userId, items),
    );

    await Promise.allSettled(flushPromises);
  }

  private async processBatchForUser(
    userId: number,
    items: ProgressQueueItem[],
  ): Promise<void> {
    const mergedWordsMap = new Map<number, WordProgressItemDto>();
    for (const item of items) {
      for (const word of item.words) {
        mergedWordsMap.set(word.id, word);
      }
    }
    const mergedWords = [...mergedWordsMap.values()];

    try {
      const result = await this.executeBatchProgressUpdate(userId, mergedWords);
      for (const item of items) {
        item.resolve(result);
      }
    } catch (error) {
      this.logger.error(`Batch flush failed for user ${userId}`, error);
      const failedIds = mergedWords.map((w) => w.id);
      const errorResult: ProgressBatchResult = {
        success: false,
        updatedIds: [],
        failedIds,
      };
      for (const item of items) {
        item.resolve(errorResult);
      }
    }
  }

  private async executeBatchProgressUpdate(
    userId: number,
    words: WordProgressItemDto[],
  ): Promise<ProgressBatchResult> {
    if (words.length === 0) {
      return { success: true, updatedIds: [], failedIds: [] };
    }

    const wordIds = words.map((w) => w.id);
    let cacheInvalidationNeeded = false;

    const result = await this.userWordRepo.manager.transaction(async (em) => {
      const updatedIds: number[] = [];
      const failedIds: number[] = [];

      const userWords = await em.find(UserWord, {
        where: { word: { id: In(wordIds) }, user: { id: userId } },
        relations: ['word'],
      });

      const userWordsMap = new Map(userWords.map((uw) => [uw.word.id, uw]));

      const updatesByStatus = new Map<StudyStatus, number[]>();

      for (const wordDto of words) {
        const userWord = userWordsMap.get(wordDto.id);
        if (!userWord) {
          failedIds.push(wordDto.id);
          continue;
        }

        const nextStatus = this.resolveNextStatus(userWord.status, wordDto);

        if (userWord.status !== nextStatus) {
          const group = updatesByStatus.get(nextStatus) ?? [];
          group.push(userWord.id);
          updatesByStatus.set(nextStatus, group);
          cacheInvalidationNeeded = true;
        }

        updatedIds.push(wordDto.id);
      }

      const updatePromises = [...updatesByStatus.entries()].map(([status, ids]) =>
        em.update(UserWord, { id: In(ids) }, { status }),
      );
      await Promise.all(updatePromises);

      return {
        success: failedIds.length === 0,
        updatedIds: updatedIds.filter((id) => !failedIds.includes(id)),
        failedIds,
      };
    });

    if (cacheInvalidationNeeded) {
      await this.clearUserWordsCache(userId);
      await this.invalidateStudySessionCache(userId);
    }

    return result;
  }

  private resolveNextStatus(
    current: StudyStatus,
    progress?: { step1: boolean; step3: boolean },
  ): StudyStatus {
    if (progress) {
      if (progress.step1 && progress.step3) return StudyStatus.LEARNED;
      if (progress.step1 || progress.step3) return StudyStatus.LEARNING;
      return current;
    }

    switch (current) {
      case StudyStatus.NEW: return StudyStatus.LEARNING;
      case StudyStatus.LEARNING: return StudyStatus.LEARNED;
      case StudyStatus.LEARNED: return StudyStatus.LEARNING;
      default: return StudyStatus.LEARNING;
    }
  }

  async clearUserWordsCache(userId: number): Promise<void> {
    try {
      await this.cacheService.clearByPattern(`user:${userId}:words:*`);
    } catch (err) {
      this.logger.error(`Не вдалося очистити кеш для юзера ${userId}`, err);
    }
  }

  // 🔧 Ті самі 6 шаблонів, але за ОДИН прохід SCAN замість шести
  // (усі мають спільний префікс `user:${userId}:`).
  public async invalidateStudySessionCache(userId: number): Promise<void> {
    await this.cacheService.clearByPatterns([
      `user:${userId}:active-package-v6:*`,
      `user:${userId}:id-pool:*`,
      `user:${userId}:word-batch:*`,
      `user:${userId}:recent-shown-words*`,
      `user:${userId}:dictionary-word-batch*`,
      `user:${userId}:recent-shown-dictionary-words*`,
    ]);
  }

  private isFieldEmpty(value: any, key?: string): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim().length === 0;
    if (Array.isArray(value)) {
      if (value.length === 0) return true;
      return value.every((item) =>
        typeof item === 'string' ? item.trim().length === 0 : item === null || item === undefined,
      );
    }
    if (typeof value === 'number') {
      if (key === 'packageId') return value === 0;
      return false;
    }
    return false;
  }

  async createWordManually(
    words: CreateWordDto[],
  ): Promise<{
    message: string;
    addedCount: number;
    overwrittenCount: number;
    skippedCount: number;
    created: Word[];
    skipped: { text: string; translation: string; reason: string }[];
  }> {
    this.logger.log(`[BULK IMPORT] Отримано слів у запиті: ${words?.length ?? 0}`);
    this.logger.log(`[BULK IMPORT] RAW BODY: ${JSON.stringify(words)}`);

    if (!words || !Array.isArray(words) || words.length === 0) {
      this.logger.log('[BULK IMPORT] Порожній масив — нічого робити');
      return {
        message: 'Немає слів для додавання',
        addedCount: 0,
        overwrittenCount: 0,
        skippedCount: 0,
        created: [],
        skipped: [],
      };
    }

    const texts = words
      .map((w) => w.text?.trim().toLowerCase())
      .filter((t): t is string => !!t);

    this.logger.log(`[BULK IMPORT] Шукаю в базі за text IN: ${JSON.stringify(texts)}`);

    const existingWords = texts.length > 0
      ? await this.wordRepo.find({ where: { text: In(texts), senseKey: '' } })
      : [];

    this.logger.log(
      `[BULK IMPORT] Знайдено в базі ${existingWords.length} збігів: ${JSON.stringify(
        existingWords.map((w) => ({ id: w.id, text: w.text })),
      )}`,
    );

    const existingByText = new Map<string, Word>();
    for (const word of existingWords) {
      existingByText.set(word.text.toLowerCase(), word);
    }

    const toSave: Word[] = [];
    const skipped: { text: string; translation: string; reason: string }[] = [];
    let newCount = 0;
    let filledCount = 0;

    for (const wordDto of words) {
      const textKey = wordDto.text?.trim().toLowerCase();
      this.logger.log(`[BULK IMPORT] === Обробка "${wordDto.text}" (ключ пошуку: "${textKey}") ===`);

      if (!textKey) {
        this.logger.log('[BULK IMPORT] Пропущено: відсутнє поле text');
        skipped.push({
          text: wordDto.text || '',
          translation: wordDto.translation || '',
          reason: 'Відсутнє поле "text" — неможливо шукати/створити слово',
        });
        continue;
      }

      const existing = existingByText.get(textKey);

      if (existing) {
        this.logger.log(
          `[BULK IMPORT] "${textKey}" ВЖЕ Є В БАЗІ (id=${existing.id}). Поточний стан запису: ${JSON.stringify(existing)}`,
        );

        let hasFilledAnyField = false;

        for (const key of Object.keys(wordDto) as Array<keyof CreateWordDto>) {
          if (key === 'text') continue;

          const incomingValue = wordDto[key];
          const incomingEmpty = this.isFieldEmpty(incomingValue, key as string);

          if (incomingEmpty) {
            this.logger.log(`[BULK IMPORT]   поле "${key}": вхідне значення порожнє (${JSON.stringify(incomingValue)}) — пропускаю`);
            continue;
          }

          const existingValue = existing[key as keyof Word];
          const existingEmpty = this.isFieldEmpty(existingValue, key as string);

          this.logger.log(
            `[BULK IMPORT]   поле "${key}": вхідне=${JSON.stringify(incomingValue)} | в базі=${JSON.stringify(existingValue)} | в базі порожнє=${existingEmpty}`,
          );

          if (existingEmpty) {
            (existing as any)[key] = incomingValue;
            hasFilledAnyField = true;
            this.logger.log(`[BULK IMPORT]   поле "${key}": ЗАПОВНЕНО новим значенням`);
          } else {
            this.logger.log(`[BULK IMPORT]   поле "${key}": В БАЗІ ВЖЕ Є ЗНАЧЕННЯ — не чіпаю`);
          }
        }

        if (hasFilledAnyField) {
          this.logger.log(`[BULK IMPORT] "${textKey}" (id=${existing.id}) буде збережено з доповненими полями`);
          toSave.push(existing);
          filledCount++;
          existingByText.set(textKey, existing);
        } else {
          this.logger.log(`[BULK IMPORT] "${textKey}" (id=${existing.id}) — жодного поля не заповнено, ІГНОРУЮ`);
          skipped.push({
            text: wordDto.text,
            translation: wordDto.translation || existing.translation,
            reason: `Усі вказані поля вже заповнені в базі (ID: ${existing.id}) — пропущено без змін`,
          });
        }
        continue;
      }

      this.logger.log(`[BULK IMPORT] "${textKey}" НЕ знайдено в базі — створюю нове слово`);
      const newWord = this.wordRepo.create(wordDto);
      toSave.push(newWord);
      newCount++;
      existingByText.set(textKey, newWord);
    }

    this.logger.log(
      `[BULK IMPORT] Перед збереженням: toSave.length=${toSave.length}, newCount=${newCount}, filledCount=${filledCount}, skipped=${skipped.length}`,
    );
    this.logger.log(`[BULK IMPORT] toSave DETAIL: ${JSON.stringify(toSave)}`);

    const saved = toSave.length > 0 ? await this.wordRepo.save(toSave) : [];

    this.logger.log(`[BULK IMPORT] Результат save(): ${JSON.stringify(saved)}`);

    if (saved.length > 0) {
      await Promise.all([
        this.cacheService.clear(WordService.ALL_WORDS_CACHE_KEY),
        this.cacheService.clear(WordService.ALL_WORDS_SHORT_CACHE_KEY),
      ]);
    }

    const messageParts = [`Додано нових слів: ${newCount}`];
    if (filledCount > 0) messageParts.push(`доповнено відсутніми полями: ${filledCount}`);
    if (skipped.length > 0) messageParts.push(`пропущено (уже заповнені/невалідні): ${skipped.length}`);

    this.logger.log(`[BULK IMPORT] ГОТОВО: ${messageParts.join(', ')}`);
    this.logger.log(`[BULK IMPORT] skipped DETAIL: ${JSON.stringify(skipped)}`);

    return {
      message: messageParts.join(', '),
      addedCount: newCount,
      overwrittenCount: filledCount,
      skippedCount: skipped.length,
      created: saved,
      skipped,
    };
  }

  /** Скарга з читалки: "не те слово / неточний переклад". */
  async createLookupReport(
    userId: number,
    data: { surface: string; context?: string; wordId?: number; bookId?: number },
  ): Promise<{ success: true; id: number }> {
    const surface = clip(data.surface, 100);
    if (!surface) throw new BadRequestException('Слово не може бути порожнім');

    const word = typeof data.wordId === 'number' ? await this.wordRepo.findOne({ where: { id: data.wordId } }) : null;
    const repo = this.wordRepo.manager.getRepository(WordLookupReport);
    const saved = await repo.save(
      repo.create({
        userId,
        surface: surface.toLowerCase(),
        context: clip(data.context, 400),
        wordId: word?.id ?? null,
        wordText: clip(word?.text, 255),
        wordTranslation: clip(word?.translation, 255),
        bookId: typeof data.bookId === 'number' ? data.bookId : null,
        status: 'open',
      }),
    );
    return { success: true, id: saved.id };
  }

  async searchOrCreateGlobalWord(
    userId: number,
    query: string,
    partOfSpeech?: string,
    context?: string,
  ): Promise<{
    word: Word;
    isAdded: boolean;
    userWordId: number | null;
    surfaceTranslation: string | null;
    surfaceAnalysis: SurfaceAnalysis | null;
    /** Форми дієслова для картки (went · gone · going); null — не дієслово. */
    verbForms: string[] | null;
    transient: boolean;
  }> {
    const startedAt = Date.now();
    // Фразу, знайдену читалкою за бібліотекою фраз, приймаємо як є: раніше
    // тут була AI-перевірка «чи вжито як фразу в реченні», але вона
    // відкидала коректні збіги (розірвані "turned his attention back",
    // "even ... up") і перекривала бібліотеку, якою тепер керують вручну
    // з адмінки. Хибні спрацювання прибираються в самій бібліотеці.
    // reader: цей маршрут викликає лише читалка — діє гарантія перекладу.
    const word = await this.wordGenService.searchOrCreateGlobalWord(query, partOfSpeech, context, { reader: true });

    // Запис не пройшов перевірку і не збережений: показуємо переклад, але
    // без додавання в словник (id = 0).
    if ((word as Word & { transient?: boolean }).transient) {
      return { word, isAdded: false, userWordId: null, surfaceTranslation: null, surfaceAnalysis: null, verbForms: null, transient: true };
    }

    await this.ensureBookEntryType(userId, word);
    await this.ensureExampleHighlights(word);

    // Розбір форми в реченні ("am walking" → "йду") окремо від перекладу
    // леми ("walk" — "ходити / йти").
    const surface = normalizeLookupQuery(query).toLowerCase();

    // ⚡ Три незалежні кроки — паралельно (раніше запис у Redis і пошук у
    // словнику користувача чекали, поки AI розбере форму слова).
    const [rawAnalysis, , existingUserWord] = await Promise.all([
      this.analyzeSurfaceWithinBudget(word, surface, context, startedAt),
      // Старі версії застосунку додають слово за ТЕКСТОМ. Коли в слова кілька
      // значень ("train" — іменник і дієслово), запам'ятовуємо, яке саме
      // користувач щойно відкрив, щоб додалось воно, а не перше-ліпше.
      // Збій Redis не має лишати користувача без перекладу.
      (async () => {
        try {
          await this.cacheService.set(this.getLastLookupCacheKey(userId, word.text), word.id, 3600);
        } catch (error) {
          this.logger.warn(`Не вдалося запам'ятати останнє відкрите значення "${word.text}": ${(error as Error)?.message}`);
        }
      })(),
      // Потрібні лише "чи є" та id запису — без повного рядка слова (eager).
      this.userWordRepo.findOne({
        where: {
          user: { id: userId },
          word: { id: word.id },
        },
        select: { id: true },
        loadEagerRelations: false,
      }),
    ]);
    // "had" у "had imagined": переклад групи ("уявив") належить головному
    // дієслову — як переклад натиснутого допоміжного слова його не віддаємо.
    const isAuxiliary = !!rawAnalysis && isAuxiliaryInVerbGroup(surface, rawAnalysis);
    const surfaceAnalysis = rawAnalysis ? { ...rawAnalysis, isAuxiliary } : null;
    const surfaceTranslation = isAuxiliary ? null : surfaceAnalysis?.contextualTranslation ?? null;

    // Ступені порівняння для картки читалки: у старих записах прикметників /
    // прислівників форм у БД може не бути (рахувались лише при створенні
    // слова, за старими правилами) — рахуємо детерміновано для відповіді,
    // у БД нічого не пишемо.
    if (!Array.isArray(word.forms) || word.forms.length === 0) {
      const degreeForms = computeDegreeForms(word.text, word.partOfSpeech);
      if (degreeForms.length > 0) word.forms = degreeForms;
    }
    // Форми на -ing у картці не показуємо, навіть якщо вони лежать у БД
    // (там вони потрібні для пошуку: "including" → include). word тут —
    // відповідь, у БД не зберігається.
    if (Array.isArray(word.forms)) word.forms = withoutIngForms(word.forms);

    return {
      word,
      isAdded: !!existingUserWord,
      userWordId: existingUserWord?.id ?? null,
      surfaceTranslation,
      surfaceAnalysis,
      verbForms: buildVerbForms(word),
      transient: false,
    };
  }

  /**
   * Правило читалки: кілька слів, виділених у книзі, — це ЗАВЖДИ фразове
   * дієслово (тип запису), навіть якщо в системі вираз уже лежить як фраза.
   * Фрази приходять лише з карток, тому записи пакетів карток (packageId)
   * не чіпаємо — інакше фраза зникла б із розділу "Фрази" у всіх користувачів.
   * Збій запису не має лишати користувача без перекладу.
   */
  private async ensureBookEntryType(userId: number, word: Word): Promise<void> {
    if (!word?.id || word.type === 'phrasal_verb') return;
    if ((word.text ?? '').trim().split(/\s+/).filter(Boolean).length < 2) return;
    if (word.packageId) return;
    try {
      await this.wordRepo.update(word.id, { type: 'phrasal_verb' });
      word.type = 'phrasal_verb';
      this.logger.log(`📚 "${word.text}" (#${word.id}): тип → phrasal_verb (кілька слів із книги)`);
      await Promise.all([
        this.cacheService.clear(WordService.ALL_WORDS_CACHE_KEY),
        this.cacheService.clear(WordService.ALL_WORDS_SHORT_CACHE_KEY),
        this.cacheService.clear(this.getWordByIdCacheKey(word.id)),
        this.cacheService.clear(this.getWordByTextCacheKey(word.text)),
        this.clearUserWordsCache(userId),
      ]);
    } catch (error) {
      this.logger.warn(`Не вдалося змінити тип "${word.text}" на phrasal_verb: ${(error as Error)?.message}`);
    }
  }

  /** Розбір форми чекаємо не довше 7 с і не довше, ніж лишилось до 14 с від початку запиту. */
  private static readonly SURFACE_ANALYSIS_BUDGET_MS = 7_000;
  private static readonly LOOKUP_TOTAL_BUDGET_MS = 14_000;
  private static readonly SURFACE_ANALYSIS_MIN_BUDGET_MS = 1_500;

  /**
   * Розбір форми в реченні — доповнення до картки, а не її основа: помилка
   * чи повільна відповідь AI не блокує переклад слова. Незавершений розбір
   * дозберігається в кеш і буде показаний при наступному натисканні.
   */
  private async analyzeSurfaceWithinBudget(
    word: Word,
    surface: string,
    context: string | undefined,
    startedAt: number,
  ): Promise<SurfaceAnalysis | null> {
    const budget = Math.min(
      WordService.SURFACE_ANALYSIS_BUDGET_MS,
      Math.max(WordService.SURFACE_ANALYSIS_MIN_BUDGET_MS, WordService.LOOKUP_TOTAL_BUDGET_MS - (Date.now() - startedAt)),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), budget);
    });
    const analysis = this.wordGenService.analyzeSurfaceInContext(word, surface, context).catch((error: unknown) => {
      this.logger.warn(`Розбір форми "${surface}" не вдався: ${(error as Error)?.message}`);
      return null;
    });
    try {
      return await Promise.race([analysis, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async adminBulkGeneratePreview(
    texts: string[],
    packageId: number | null,
    partOfSpeech?: string,
  ) {
    return this.wordGenService.generateBulkPreview(texts, packageId, partOfSpeech);
  }

  async updateWords(
    data: Partial<Word> | Array<Partial<Word>>,
  ): Promise<{ message: string; updated: Word[] }> {
    const items = Array.isArray(data) ? data : [data];
    const updatedWords: Word[] = [];

    for (const item of items) {
      if (!item.id) throw new BadRequestException("Кожен об'єкт повинен мати id");

      const existing = await this.wordRepo.findOne({ where: { id: item.id } });
      if (!existing) continue;

      const { id, createdAt, userWords, ...safeFields } = item as any;

      await this.wordRepo.update(id, safeFields);

      const updated = await this.wordRepo.findOne({ where: { id } });
      if (updated) {
        updatedWords.push(updated);
      }
    }

    await Promise.all([
      ...updatedWords.map((w) => this.cacheService.clear(this.getWordByIdCacheKey(w.id))),
      ...updatedWords.map((w) => this.cacheService.clear(this.getWordByTextCacheKey(w.text))),
      this.cacheService.clear(WordService.ALL_WORDS_CACHE_KEY),
      this.cacheService.clear(WordService.ALL_WORDS_SHORT_CACHE_KEY),
    ]);

    return {
      message: `✅ Оновлено ${updatedWords.length} слів`,
      updated: updatedWords,
    };
  }

  async deleteWord(wordId: number): Promise<{ success: boolean; message: string }> {
    const word = await this.wordRepo.findOne({ where: { id: wordId } });
    if (!word) throw new NotFoundException('Слово не знайдено');

    await this.userWordRepo.delete({ word: { id: wordId } });
    await this.wordRepo.delete(wordId);

    await Promise.all([
      this.cacheService.clear(WordService.ALL_WORDS_CACHE_KEY),
      this.cacheService.clear(WordService.ALL_WORDS_SHORT_CACHE_KEY),
      this.cacheService.clear(this.getWordByIdCacheKey(wordId)),
      this.cacheService.clear(this.getWordByTextCacheKey(word.text)),
      // Як і масові видалення: закешовані списки словника користувачів не
      // мають далі показувати видалене слово.
      this.cacheService.clearByPattern('user:*:words:*'),
    ]);

    return { success: true, message: `Слово "${word.text}" успішно видалене` };
  }

async addOrGetUserWord(
  userId: number,
  rawText: string,
  userTranslation?: string,
  userText?: string,
  partOfSpeech?: string,
  source?: DictionarySource,
): Promise<(UserWord & { correction?: WordCorrectionInfo; transient?: boolean }) | null> {
  const text = rawText.normalize('NFC').trim().replace(/\.\s*$/, '');
  if (!text) {
    this.logger.warn('Provided text is empty, skipping.');
    return null;
  }

  const user = await this.userRepo.findOne({ where: { id: userId } });
  if (!user) {
    this.logger.error(`User with id=${userId} not found`);
    return null;
  }

  // Словник уже заповнено — відмовляємо ДО генерації через ШІ (інакше
  // платили б OpenAI за слово, яке все одно не додасться).
  const capacity = await loadDictionaryCapacity(this.userWordRepo.manager, userId);
  if (capacity.reached) throw new DictionaryLimitReachedException(capacity);

  const correction = await this.spellCorrectionService.resolve(text);

  if (correction.corrected) {
    this.logger.log(
      `✏️ Ввід виправлено (${correction.method}): "${correction.originalQuery}" → "${correction.query}"`,
    );
  }

  let word: Word;
  let layoutCorrection: WordCorrectionInfo | undefined;

  if (correction.matchedWord) {
    word = correction.matchedWord;
  } else if (/[а-яіїєґ]/i.test(correction.query)) {
    // Український ввід: переклад за словником → забута розкладка (лише якщо
    // таке англійське слово існує) → AI. Раніше будь-яка кирилиця спершу
    // перекладалась "розкладкою": "машина часу" → "vfibyf xfce".
    const resolved = await this.wordGenService.resolveUkrainianQuery(correction.query);
    if (!resolved) {
      throw new NotFoundException(`Не вдалося знайти переклад для «${text}». Перевірте написання.`);
    }
    if (resolved.method === 'keyboard_layout') {
      layoutCorrection = { original: correction.originalQuery, applied: resolved.english, method: 'keyboard_layout', confidence: 1 };
    }
    word = resolved.matchedWord ?? (await this.wordGenService.searchOrCreateGlobalWord(resolved.english, partOfSpeech));
  } else {
    try {
      word = await this.wordGenService.searchOrCreateGlobalWord(correction.query.toLowerCase(), partOfSpeech);
    } catch (error) {
      this.logger.error(`Генерація слова "${correction.query}" провалилась`, error as Error);
      throw error;
    }
  }

  if (!word) {
    this.logger.error(`Слово для запиту "${correction.query}" не отримано.`);
    return null;
  }

  // Запис не пройшов перевірку і не збережений у словнику: повертаємо
  // переклад, але не додаємо його користувачу.
  if ((word as Word & { transient?: boolean }).transient) {
    return { id: null, word, transient: true } as unknown as UserWord & { transient: boolean };
  }

  await this.ensureExampleHighlights(word);

const correctionInfo: WordCorrectionInfo | undefined = layoutCorrection ??
  (correction.method !== 'none'
    ? {
        original: correction.originalQuery,
        applied: correction.query,
        method: correction.method,
        confidence: correction.confidence,
      }
    : undefined);

  // Перевірка "чи вже є" і вставка — під блокуванням на пару
  // (користувач, слово), як у simple-add. Гілка з помилкою 23505 нижче
  // ніколи не спрацьовувала: унікального індексу на user_word немає, тож
  // паралельні запити створювали дублікати.
  const lockedResult = await this.userWordRepo.manager.transaction(async (em) => {
    await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`user_word:${user.id}:${word.id}`]);

    const existing = await em.findOne(UserWord, {
      where: { user: { id: user.id }, word: { id: word.id } },
      relations: ['user', 'word'],
    });
    if (existing) return { existing, created: null as UserWord | null };

    // Ліміт словника — лише для НОВИХ записів (повторне додавання — ок).
    await assertDictionaryCapacity(em, user.id, 1);

    const created = await em.save(
      em.create(UserWord, {
        user,
        word,
        status: StudyStatus.NEW,
        userTranslation: userTranslation?.trim() || undefined,
        userText: userText?.trim() || undefined,
        sourceType: source?.type ?? 'manual',
        sourceBookId: source?.bookId ?? null,
        sourceBookTitle: source?.bookTitle ?? null,
        sourceSentence: clip(source?.sentence, 400),
        sourceSurface: clip(source?.surface, 100),
        nextReviewAt: new Date(),
      }),
    );
    return { existing: null as UserWord | null, created };
  });

  const existingUserWord = lockedResult.existing;

  if (existingUserWord) {
    let touched = false;

    if (userTranslation?.trim() && !existingUserWord.userTranslation) {
      existingUserWord.userTranslation = userTranslation.trim();
      touched = true;
    }

    if (userText?.trim() && !existingUserWord.userText) {
      existingUserWord.userText = userText.trim();
      touched = true;
    }

    if (touched) {
      await this.userWordRepo.save(existingUserWord);
      await this.clearUserWordsCache(userId);
    }

    existingUserWord.word = word;
    existingUserWord.user = user;

    return Object.assign(existingUserWord, { correction: correctionInfo });
  }

  const savedUserWord = lockedResult.created as UserWord;

  await this.clearUserWordsCache(userId);
  await this.invalidateStudySessionCache(userId);

  savedUserWord.word = word;
  savedUserWord.user = user;

  return Object.assign(savedUserWord, { correction: correctionInfo });
}

  async addSimpleWordToUserList(
    userId: number,
    input: string,
    source?: DictionarySource,
    wordId?: number,
  ): Promise<UserWord> {
    const normalizedInput = input.trim();

    // 1. Новий клієнт передає id саме того значення, яке показала читалка.
    // 2. Старий клієнт — лише текст: беремо значення, яке користувач щойно
    //    відкрив (search-or-create), і лише потім — основне значення слова.
    let word: Word | null = null;
    if (typeof wordId === 'number' && Number.isInteger(wordId) && wordId > 0) {
      word = await this.wordRepo.findOne({ where: { id: wordId } });
    }
    if (!word && normalizedInput) {
      const lastLookupId = await this.cacheService.get<number>(this.getLastLookupCacheKey(userId, normalizedInput));
      if (typeof lastLookupId === 'number') {
        const candidate = await this.wordRepo.findOne({ where: { id: lastLookupId } });
        if (candidate && candidate.text.toLowerCase() === normalizedInput.toLowerCase()) word = candidate;
      }
    }
    if (!word && normalizedInput) {
      word = await this.wordRepo.findOne({
        where: [{ text: ILike(normalizedInput) }, { translation: ILike(normalizedInput) }],
        order: { id: 'ASC' },
      });
    }

    if (!word) {
      throw new NotFoundException(
        `Слово або переклад "${input}" не знайдено в загальному списку.`,
      );
    }

    // Перевірка "чи вже є" і вставка — під транзакційним блокуванням на
    // пару (користувач, слово): подвійний тап / повтор запиту після 429
    // раніше міг створити два однакові записи в словнику. Блокування
    // знімається з кінцем транзакції; іншим користувачам не заважає.
    const result = await this.userWordRepo.manager.transaction(async (em) => {
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`user_word:${userId}:${word!.id}`]);

      const existing = await em.findOne(UserWord, {
        where: { user: { id: userId }, word: { id: word!.id } },
      });
      if (existing) return { id: existing.id, created: false };

      await assertDictionaryCapacity(em, userId, 1);

      const saved = await em.save(
        em.create(UserWord, {
          user: { id: userId },
          word: { id: word!.id },
          status: StudyStatus.NEW,
          sourceType: source?.type ?? 'package',
          sourceBookId: source?.bookId ?? null,
          sourceBookTitle: source?.bookTitle ?? null,
          sourceSentence: clip(source?.sentence, 400),
          sourceSurface: clip(source?.surface, 100),
          nextReviewAt: new Date(),
        }),
      );
      return { id: saved.id, created: true };
    });

    if (result.created) {
      await this.clearUserWordsCache(userId);
      await this.invalidateStudySessionCache(userId);
    }

    const finalUserWord = await this.userWordRepo.findOne({
      where: { id: result.id },
      relations: ['user', 'word'],
    });

    if (!finalUserWord) {
      throw new InternalServerErrorException('Не вдалося отримати збережене слово.');
    }

    return finalUserWord;
  }

  /** Стан словника для застосунку: ліміт показується лише коли досягнуто. */
  async getDictionaryCapacity(userId: number): Promise<DictionaryCapacity> {
    return loadDictionaryCapacity(this.userWordRepo.manager, userId);
  }

  async addManyWordsToUser(userId: number, wordTexts: string[]): Promise<UserWord[]> {
    const normalizedTexts = [...new Set(wordTexts.map((w) => w.trim().toLowerCase()))].filter(
      (t) => t.length > 0,
    );

    if (normalizedTexts.length === 0) return [];

    const words = await this.wordRepo.find({ where: { text: In(normalizedTexts), senseKey: '' } });
    if (!words || words.length === 0) {
      throw new NotFoundException('Жодне слово не знайдено в глобальному списку');
    }

    const wordsMap = new Map(words.map((w) => [w.id, w]));
    const wordIds = words.map((w) => w.id);

    // Перевірка "чи вже є" і вставка — під тими самими блокуваннями, що й
    // у simple-add (по парі користувач+слово), інакше паралельні запити
    // створювали дублікати. Порядок блокувань — за id, щоб два запити з
    // перетином слів не заблокували один одного навхрест.
    const { existingUserWords, savedNewWords } = await this.userWordRepo.manager.transaction(async (em) => {
      for (const id of [...wordIds].sort((a, b) => a - b)) {
        await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`user_word:${userId}:${id}`]);
      }

      const existing = await em.find(UserWord, {
        where: { user: { id: userId }, word: { id: In(wordIds) } },
        relations: ['word'],
      });
      const existingIds = new Set(existing.map((uw) => uw.word.id));

      const toCreate = words
        .filter((word) => !existingIds.has(word.id))
        .map((word) =>
          em.create(UserWord, {
            user: { id: userId },
            word: { id: word.id },
            status: StudyStatus.NEW,
          }),
        );

      await assertDictionaryCapacity(em, userId, toCreate.length);
      const saved = toCreate.length > 0 ? await em.save(toCreate) : [];
      return { existingUserWords: existing, savedNewWords: saved };
    });

    if (savedNewWords.length > 0) {

      for (const uw of savedNewWords) {
        const wordId = (uw.word as any).id;
        if (typeof wordId === 'number') {
          const fullWord = wordsMap.get(wordId);
          if (fullWord) uw.word = fullWord;
        }
      }

      await this.clearUserWordsCache(userId);
      await this.invalidateStudySessionCache(userId);
    }

    return [...existingUserWords, ...savedNewWords];
  }

  async updateUserWordProgressBatch(
    userId: number,
    words: WordProgressItemDto[],
  ): Promise<ProgressBatchResult> {
    if (!words || words.length === 0) {
      this.logger.warn(`[WordService.batch] userId=${userId}: порожній масив слів.`);
      return { success: true, updatedIds: [], failedIds: [] };
    }

    // Ліміт списується лише за слова з завершеного циклу; partial (вихід
    // посеред циклу) — лише зберігає прогрес, ліміт не чіпає.
    const partialWords = words.filter((w) => w.partial);
    const limitedWords = words.filter((w) => !w.partial);

    const { granted } = await this.dailyLimitService.reserveSlots(userId, limitedWords.length, 'cards');
    const grantedWords = granted < limitedWords.length ? limitedWords.slice(0, granted) : limitedWords;
    const skippedWords = granted < limitedWords.length ? limitedWords.slice(granted) : [];
    const wordsToProcess = [...grantedWords, ...partialWords];

    if (granted < limitedWords.length) {
      this.logger.warn(
        `[WordService.batch] userId=${userId}: денний ліміт дозволив лише ${granted}/${limitedWords.length} слів. ` +
        `Пропущені через ліміт: [${skippedWords.map((w) => w.id).join(', ')}].`,
      );
    }

    if (wordsToProcess.length === 0) {
      this.logger.warn(`[WordService.batch] userId=${userId}: ліміт вичерпано, жодне слово не буде оброблено.`);
      return { success: false, updatedIds: [], failedIds: words.map((w) => w.id) };
    }

    const result = await this.userWordProgressService.updateUserWordProgressBatch(userId, wordsToProcess);

    await this.invalidateStudySessionCache(userId);

    this.logger.log(
      `[WordService.batch] userId=${userId}: готово. updatedIds=[${result.updatedIds.join(', ')}], ` +
      `failedIds=[${result.failedIds.join(', ')}]`,
    );

    return {
      ...result,
      failedIds: [...result.failedIds, ...skippedWords.map((w) => w.id)],
    };
  }

  async updateUserWordProgress(userId: number, wordId: number): Promise<any> {
    await this.dailyLimitService.consumeOne(userId, 'cards');

    const result = await this.userWordProgressService.updateUserWordProgress(userId, wordId);
    await this.invalidateStudySessionCache(userId);
    return result;
  }

  private resolveNextStatusLinear(current: StudyStatus): StudyStatus {
    switch (current) {
      case StudyStatus.NEW: return StudyStatus.LEARNING;
      case StudyStatus.LEARNING: return StudyStatus.LEARNED;
      case StudyStatus.LEARNED: return StudyStatus.LEARNING;
      default: return StudyStatus.LEARNING;
    }
  }

  async advanceUserWordsStatus(
    userId: number,
    wordIds: number[],
  ): Promise<ProgressBatchResult> {
    if (!wordIds || wordIds.length === 0) {
      return { success: true, updatedIds: [], failedIds: [] };
    }

    const updatedIds: number[] = [];
    const failedIds: number[] = [];
    let cacheInvalidationNeeded = false;

    await this.userWordRepo.manager.transaction(async (em) => {
      const userWords = await em.find(UserWord, {
        where: { id: In(wordIds), user: { id: userId } },
      });
      const map = new Map(userWords.map((uw) => [uw.id, uw]));

      const updatesByStatus = new Map<StudyStatus, number[]>();

      for (const wordId of wordIds) {
        const userWord = map.get(wordId);
        if (!userWord) {
          failedIds.push(wordId);
          continue;
        }

        const nextStatus = this.resolveNextStatusLinear(userWord.status);

        if (userWord.status !== nextStatus) {
          const group = updatesByStatus.get(nextStatus) ?? [];
          group.push(wordId);
          updatesByStatus.set(nextStatus, group);
          cacheInvalidationNeeded = true;
        }

        updatedIds.push(wordId);
      }

      const updatePromises = [...updatesByStatus.entries()].map(([status, ids]) =>
        em.update(UserWord, { id: In(ids) }, { status }),
      );
      await Promise.all(updatePromises);
    });

    if (cacheInvalidationNeeded) {
      await this.clearUserWordsCache(userId);
      await this.invalidateStudySessionCache(userId);
    }

    return {
      success: failedIds.length === 0,
      updatedIds,
      failedIds,
    };
  }

  async resetUserWordProgress(userId: number, userWordId: number): Promise<UpdateResult> {
    const updateResult = await this.userWordRepo.update(
      { id: userWordId, user: { id: userId } },
      { status: StudyStatus.NEW },
    );

    if (!updateResult.affected || updateResult.affected === 0) {
      throw new NotFoundException('Слово не знайдено у вашому словнику');
    }

    await this.clearUserWordsCache(userId);
    await this.invalidateStudySessionCache(userId);
    return updateResult;
  }

  async resetUserProgressBatch(
    userId: number,
    userWordIds: number[],
  ): Promise<{ success: boolean; updatedCount: number }> {
    if (!userWordIds || userWordIds.length === 0) {
      return { success: true, updatedCount: 0 };
    }

    const updateResult = await this.userWordRepo.update(
      { id: In(userWordIds), user: { id: userId } },
      { status: StudyStatus.NEW },
    );

    const updatedCount = updateResult.affected || 0;
    if (updatedCount > 0) {
      await this.clearUserWordsCache(userId);
      await this.invalidateStudySessionCache(userId);
    }

    return { success: true, updatedCount };
  }

  async resetUserProgressByLevel(
    userId: number,
    level: string,
  ): Promise<{ success: boolean; updatedCount: number }> {
    const qb = this.userWordRepo
      .createQueryBuilder()
      .update(UserWord)
      .set({ status: StudyStatus.NEW })
      .where('"userId" = :userId', { userId });

    if (level !== 'all') {
      const subQuery = this.userWordRepo
        .createQueryBuilder('uw')
        .select('uw.id')
        .leftJoin('uw.word', 'w')
        .where('uw.userId = :userId', { userId })
        .andWhere('w.level = :level', { level });

      qb.andWhere(`"id" IN (${subQuery.getQuery()})`);
      qb.setParameters({ userId, level });
    }

    const updateResult = await qb.execute();
    const updatedCount = updateResult.affected || 0;

    if (updatedCount > 0) {
      await this.clearUserWordsCache(userId);
      await this.invalidateStudySessionCache(userId);
    }

    return { success: true, updatedCount };
  }

  async deleteUserWord(userId: number, userWordId: number): Promise<DeleteResult> {
    const deleteResult = await this.userWordRepo.delete({
      id: userWordId,
      user: { id: userId },
    });

    if (!deleteResult.affected || deleteResult.affected === 0) {
      throw new NotFoundException('Слово не знайдено у вашому словнику');
    }

    await this.clearUserWordsCache(userId);
    await this.invalidateStudySessionCache(userId);
    return deleteResult;
  }

  async deleteUserWordsBatch(
    userId: number,
    userWordIds: number[],
  ): Promise<{ success: boolean; deletedCount: number }> {
    if (!userWordIds || userWordIds.length === 0) {
      return { success: true, deletedCount: 0 };
    }

    const deleteResult = await this.userWordRepo.delete({
      id: In(userWordIds),
      user: { id: userId },
    });

    const deletedCount = deleteResult.affected || 0;
    if (deletedCount > 0) {
      await this.clearUserWordsCache(userId);
      await this.invalidateStudySessionCache(userId);
    }

    return { success: true, deletedCount };
  }

  async updateUserWordCustomData(
    userId: number,
    userWordId: number,
    userText?: string,
    userTranslation?: string,
  ): Promise<UserWord> {
    const userWord = await this.userWordRepo.findOne({
      where: { id: userWordId, user: { id: userId } },
      relations: ['word'],
    });

    if (!userWord) {
      throw new NotFoundException(`UserWord з id ${userWordId} не знайдено у користувача`);
    }

    if (userText !== undefined) userWord.userText = userText;
    if (userTranslation !== undefined) userWord.userTranslation = userTranslation;

    const savedUserWord = await this.userWordRepo.save(userWord);
    await this.clearUserWordsCache(userId);

    return savedUserWord;
  }

  async findWordById(id: number): Promise<Word | null> {
    return this.cacheService.getOrSet(
      this.getWordByIdCacheKey(id),
      () => this.wordRepo.findOneBy({ id }),
      null,
    );
  }

  async findWordByText(text: string): Promise<Word | null> {
    return this.cacheService.getOrSet(
      this.getWordByTextCacheKey(text),
      () => this.wordRepo.findOne({ where: { text }, order: { id: 'ASC' } }),
      null,
    );
  }

  async getAllWords(): Promise<Word[]> {
    return this.cacheService.getOrSet(
      WordService.ALL_WORDS_CACHE_KEY,
      () => this.wordRepo.find({ order: { createdAt: 'DESC' } }),
      null,
    );
  }

  async getAllWordsShort(): Promise<{ id: number; text: string; pronunciation: string; translation: string }[]
  > {
    return this.cacheService.getOrSet(
      WordService.ALL_WORDS_SHORT_CACHE_KEY,
      async () => {
        const words = await this.wordRepo.find({ order: { createdAt: 'DESC' } });
        return words.map((word) => ({
          id: word.id,
          text: word.text,
          pronunciation: word.pronunciation,
          translation: word.translation,
        }));
      },
      null,
    );
  }

  async getAllWordsPronunciations(): Promise<{ id: number; pronunciation: string }[]> {
    const words = await this.wordRepo.find({
      select: ['id', 'pronunciation'],
    });
    return words.map((word) => ({ id: word.id, pronunciation: word.pronunciation }));
  }

  async getUserWords(userId: number): Promise<UserWord[]> {
    return this.userWordRepo.find({
      where: { user: { id: userId } },
      relations: ['word', 'user'],
      order: { addedAt: 'DESC' },
    });
  }

  async getUserWordsShort(
    userId: number,
  ): Promise<{ id: number; text: string; level: string; pronunciation: string; translation: string }[]
  > {
    const userWords = await this.userWordRepo.find({
      where: { user: { id: userId } },
      relations: ['word'],
      order: { addedAt: 'DESC' },
    });

    return userWords.map(({ id, word }) => ({
      id,
      text: word.text,
      level: word.level,
      pronunciation: word.pronunciation,
      translation: word.translation,
    }));
  }

  async getUserWordById(userId: number, userWordId: number): Promise<UserWord | null> {
    return this.userWordRepo.findOne({
      where: { id: userWordId, user: { id: userId } },
      relations: ['word'],
    });
  }

async getUserWordsPaginated(
  userId: number,
  page = 1,
  pageSize = 10,
  level?: string,
  status?: string,
  searchQuery?: string,
  type?: string,
): Promise<UserWord[]> {
  const hasSearch = searchQuery && searchQuery.trim().length > 0;
  const safePage = hasSearch ? 1 : Math.max(1, page);
  const safePageSize = Math.min(Math.max(1, pageSize), 100);

  // 🔧 Без JOIN з таблицею user: раніше до КОЖНОГО слова в відповіді
  // додавався повний рядок користувача (разом з хешем пароля). Фільтр
  // той самий — по FK userWord."userId".
  const query = this.userWordRepo
    .createQueryBuilder('userWord')
    .leftJoinAndSelect('userWord.word', 'word')
    .where('"userWord"."userId" = :userId', { userId });

  if (type && type !== 'all') {
    query.andWhere('word.type = :type', { type });
  }

  if (status && status !== 'all') {
    if (status === 'new') {
      query.andWhere('userWord.status IN (:...statusConditions)', {
        statusConditions: ['new', 'learning'],
      });
    } else if (status === 'favorite') {
      query.andWhere('userWord.isFavorite = true');
    } else {
      query.andWhere('userWord.status = :statusCondition', { statusCondition: status });
    }
  }

  if (hasSearch) {
    query.andWhere(
      '(LOWER(word.text) LIKE LOWER(:search) OR LOWER(word.translation) LIKE LOWER(:search))',
      { search: `%${searchQuery!.trim()}%` },
    );
  }

  const levels = parseLevelsFilter(level);
  if (levels.length > 0) {
    query.andWhere('UPPER(TRIM(word.level)) IN (:...levels)', { levels });
  }

  query.orderBy('userWord.addedAt', 'DESC');
  query.addOrderBy('userWord.id', 'DESC');

  query.offset((safePage - 1) * safePageSize).limit(safePageSize);

  const userWords = await query.getMany();

  const wordsToProcess = userWords.map(uw => uw.word).filter(Boolean);
  if (wordsToProcess.length > 0) {
    await this.ensureExampleHighlightsBatch(wordsToProcess);
  }

  this.attachUserFieldsToWord(userWords);

  return userWords;
}

  async searchWords(query: string): Promise<Word[]> {
    if (!query) return [];

    const cleanQuery = query.trim();

    return this.wordRepo
      .createQueryBuilder('word')
      .where('LOWER(word.text) LIKE LOWER(:textQuery)', { textQuery: `${cleanQuery}%` })
      .orWhere('LOWER(word.translation) LIKE LOWER(:transQuery)', { transQuery: `%${cleanQuery}%` })
      .orderBy('word.text', 'ASC')
      .limit(50)
      .getMany();
  }

  async toggleFavorite(userId: number, id: number): Promise<UserWord> {
    const userWord = await this.userWordRepo.findOne({
      where: { id, user: { id: userId } },
    });

    if (!userWord) {
      throw new NotFoundException('Слово у вашому словнику не знайдено');
    }

    userWord.isFavorite = !userWord.isFavorite;

    return this.userWordRepo.save(userWord);
  }

  async updateUserWordNotes(userId: number, id: number, notes: string): Promise<UserWord> {
    const userWord = await this.userWordRepo.findOne({
      where: { id, user: { id: userId } },
    });

    if (!userWord) {
      throw new NotFoundException('Слово у вашому словнику не знайдено');
    }

    userWord.notes = notes && notes.trim().length > 0 ? notes.trim() : null;

    return this.userWordRepo.save(userWord);
  }

  async searchUserWords(
    userId: number,
    searchQuery: string,
    level?: string,
    status?: StudyStatus,
  ): Promise<UserWord[]> {
    // 🔧 Без JOIN з таблицею user (див. getUserWordsPaginated).
    const query = this.userWordRepo
      .createQueryBuilder('userWord')
      .leftJoinAndSelect('userWord.word', 'word')
      .where('"userWord"."userId" = :userId', { userId });

    const levels = parseLevelsFilter(level);
    if (levels.length > 0) {
      query.andWhere('UPPER(TRIM(word.level)) IN (:...levels)', { levels });
    }

    const currentStatusStr = status as string;
    if (status && currentStatusStr !== 'all') {
      if (currentStatusStr === 'new') {
        query.andWhere('userWord.status = :statusCondition', {
          statusCondition: 'new',
        });
      } else {
        query.andWhere('userWord.status = :statusCondition', {
          statusCondition: currentStatusStr,
        });
      }
    }

    if (searchQuery) {
      query.andWhere(
        '(LOWER(word.text) LIKE LOWER(:search) OR LOWER(word.translation) LIKE LOWER(:search))',
        { search: `%${searchQuery.trim()}%` },
      );
    }

    query.limit(50);

    const userWords = await query.getMany();

    const wordsToProcess = userWords.map(uw => uw.word).filter(Boolean);
    if (wordsToProcess.length > 0) {
      await this.ensureExampleHighlightsBatch(wordsToProcess);
    }

    this.attachUserFieldsToWord(userWords);
    return userWords;
  }

  async searchWordsWithUserStatus(
    userId: number,
    query: string,
  ): Promise<{ word: Word; isAdded: boolean }[]> {
    const globalWords = await this.wordRepo
      .createQueryBuilder('word')
      .where('LOWER(word.text) LIKE :query', { query: `%${query}%` })
      .orWhere('LOWER(word.translation) LIKE :query', { query: `%${query}%` })
      .limit(50)
      .getMany();

    if (globalWords.length === 0) return [];

    const globalWordIds = globalWords.map((word) => word.id);

    const userWords = await this.userWordRepo.find({
      where: { user: { id: userId }, word: { id: In(globalWordIds) } },
      relations: ['word'],
    });

    const userWordIds = new Set(userWords.map((uw) => uw.word.id));
    return globalWords.map((word) => ({ word, isAdded: userWordIds.has(word.id) }));
  }

  async findExactWordWithUserStatus(
    userId: number,
    searchText: string,
  ): Promise<{ word: WordWithUserTranslation | null; isAdded: boolean }> {
    const cleanedText = searchText.replace(/[.,!?;:()'"`]/g, '').toLowerCase();

    const word = await this.wordRepo.findOne({
      where: [
        { text: Raw((alias) => `LOWER(${alias}) = :cleanedText`, { cleanedText }) },
        { translation: Raw((alias) => `LOWER(${alias}) = :cleanedText`, { cleanedText }) },
      ],
    });

    if (!word) return { word: null, isAdded: false };

    await this.ensureExampleHighlights(word);

    const userWord = await this.userWordRepo.findOne({
      where: { user: { id: userId }, word: { id: word.id } },
    });

    const wordWithUserTranslation: WordWithUserTranslation = {
      ...word,
      userTranslation: userWord?.userTranslation || null,
      userText: userWord?.userText || null,
    };

    return { word: wordWithUserTranslation, isAdded: !!userWord };
  }

  async getUserRandomDictionaryWordsForStudy(
    userId: number,
    requestedCount = 1,
    filters?: DictionaryFilters,
  ): Promise<{ words: any[]; totalDictionaryWords: number; learnedDictionaryWords: number }> {
    try {
      const stats = await this.getUserDictionaryStats(userId, filters);

      const limitStatus = await this.dailyLimitService.getStatus(userId);
      if (!limitStatus.unlimited && limitStatus.remaining <= 0) {
        return {
          words: [],
          totalDictionaryWords: stats.totalWords,
          learnedDictionaryWords: stats.learnedWords,
        };
      }

      const safeCount = Math.max(1, Math.min(requestedCount, this.BATCH_SIZE));
      const filterKey = this.buildDictionaryFilterKey(filters);

      const userWords = await this.getNextDictionaryWordBatch(userId, filterKey, safeCount, filters);

      if (userWords.length === 0) {
        return {
          words: [],
          totalDictionaryWords: stats.totalWords,
          learnedDictionaryWords: stats.learnedWords,
        };
      }

      await this.ensureExampleHighlightsBatch(userWords.map((uw) => uw.word));

      return {
        words: userWords.map((uw) => this.mapDictionaryUserWordToDto(uw, stats)),
        totalDictionaryWords: stats.totalWords,
        learnedDictionaryWords: stats.learnedWords,
      };
    } catch (error) {
      this.logger.error(`Failed to get random dictionary words for user ${userId}`, error);
      return { words: [], totalDictionaryWords: 0, learnedDictionaryWords: 0 };
    }
  }

  /**
   * Стабільний ключ фільтра словника — щоб різні комбінації
   * bookIds/packages/manual/favoritesOnly мали окремий батч-кеш і не
   * "перетирали" один одного (інакше перемикання фільтра скидало б
   * прогрес по вже показаних словах в іншому фільтрі, і навпаки).
   */
  private buildDictionaryFilterKey(filters?: DictionaryFilters): string {
    if (!filters) return 'none';

    const bookIds = [...(filters.bookIds ?? [])].sort((a, b) => a - b).join(',');

    const key = [
      bookIds ? `b:${bookIds}` : '',
      filters.packages ? 'p' : '',
      filters.manual ? 'm' : '',
      filters.favoritesOnly ? 'f' : '',
      filters.levels?.length ? `l:${[...filters.levels].sort().join(',')}` : '',
    ]
      .filter(Boolean)
      .join('|');

    return key || 'none';
  }

  /**
   * Видає наступну "пачку" слів зі словника користувача.
   *
   * Раніше тут був прямий ORDER BY + LIMIT — тому при незмінних
   * nextReviewAt/addedAt повторний виклик завжди повертав ті самі
   * top-N слова. Тепер замість цього ведеться курсор по заздалегідь
   * згенерованому й перемішаному пулу id-шок (кешується на BATCH_TTL):
   * - кожен виклик віддає НАСТУПНУ порцію з пулу, а не одну й ту саму;
   * - коли пул вичерпується, генерується новий, а слова, показані щойно,
   *   відсуваються в кінець своєї пріоритетної групи — щоб одразу не
   *   повторитись (якщо в словнику мало слів, вони все одно повернуться,
   *   просто не в першу чергу).
   */
  private async getNextDictionaryWordBatch(
    userId: number,
    filterKey: string,
    safeCount: number,
    filters?: DictionaryFilters,
  ): Promise<UserWord[]> {
    const batchKey = `user:${userId}:dictionary-word-batch:${filterKey}`;

    let batch: DictionaryBatchCache | null =
      (await this.cacheService.get<DictionaryBatchCache>(batchKey)) ?? null;
    if (!batch || batch.cursor >= batch.orderedIds.length) {
      batch = await this.buildDictionaryBatch(userId, filterKey, filters);
    }
    if (!batch || batch.orderedIds.length === 0) return [];

    let sliceIds = batch.orderedIds.slice(batch.cursor, batch.cursor + safeCount);
    let cursor = batch.cursor + sliceIds.length;

    // Дійшли до хвоста пулу, але в словнику загалом слів не менше safeCount —
    // перегенеровуємо пул (враховуючи щойно показане в цьому ж виклику) і
    // добираємо решту, щоб віддати повний safeCount, а не куций залишок.
    if (sliceIds.length < safeCount && batch.orderedIds.length >= safeCount) {
      const freshBatch = await this.buildDictionaryBatch(userId, filterKey, filters, sliceIds);
      if (freshBatch && freshBatch.orderedIds.length > 0) {
        const stillNeeded = safeCount - sliceIds.length;
        const topUpIds = freshBatch.orderedIds
          .filter((id) => !sliceIds.includes(id))
          .slice(0, stillNeeded);

        sliceIds = [...sliceIds, ...topUpIds];
        batch = freshBatch;
        cursor = topUpIds.length;
      }
    }

    await this.cacheService.set(
      batchKey,
      { orderedIds: batch.orderedIds, cursor },
      this.BATCH_TTL,
    );

    if (sliceIds.length === 0) return [];

    const recentKey = `user:${userId}:recent-shown-dictionary-words:${filterKey}`;
    const recentIds = (await this.cacheService.get<number[]>(recentKey)) ?? [];
    const updatedRecent = [...sliceIds, ...recentIds].slice(0, this.RECENT_SHOWN_MAX);
    await this.cacheService.set(recentKey, updatedRecent, this.BATCH_TTL);

    const userWords = await this.userWordRepo.find({
      where: { id: In(sliceIds) },
      relations: ['word'],
    });

    const orderMap = new Map(sliceIds.map((id, idx) => [id, idx]));
    userWords.sort((a, b) => orderMap.get(a.id)! - orderMap.get(b.id)!);

    return userWords;
  }

  /**
   * Генерує (і кешує) новий пул id-шок UserWord для словника, у трьох
   * пріоритетних групах:
   * 0) щойно додані слова, які ще не проходили жодного повторення
   *    (status = NEW) — сортовані за addedAt DESC, найсвіжіше першим,
   *    БЕЗ перемішування, щоб саме вони йшли в чергу першими;
   * 1) прострочені по SRS повторення (nextReviewAt <= NOW), перемішані;
   * 2) ще не due, перемішані — сюди ж тимчасово потрапляють слова,
   *    щойно позначені "не знаю" (див. WRONG_ANSWER_COOLDOWN_MS): їхній
   *    nextReviewAt зсунуто в майбутнє, тож вони не воскресають у групі
   *    (1) одразу ж, а трохи пізніше, коли кулдаун мине.
   * Слова, показані щойно (recent), відсуваються в кінець своєї групи.
   */
  private async buildDictionaryBatch(
    userId: number,
    filterKey: string,
    filters?: DictionaryFilters,
    extraRecentIds: number[] = [],
  ): Promise<DictionaryBatchCache | null> {
    const recentKey = `user:${userId}:recent-shown-dictionary-words:${filterKey}`;
    const cachedRecent = (await this.cacheService.get<number[]>(recentKey)) ?? [];
    const recentSet = new Set([...cachedRecent, ...extraRecentIds]);

    const qb = this.userWordRepo
      .createQueryBuilder('uw')
      .select('uw.id', 'id')
      .addSelect('uw."addedAt"', 'addedAt')
      .addSelect(
        `CASE
          WHEN uw.status = :newStatus THEN 0
          WHEN uw."nextReviewAt" <= NOW() THEN 1
          ELSE 2
        END`,
        'priorityRank',
      )
      .setParameter('newStatus', StudyStatus.NEW)
      .where('uw."userId" = :userId', { userId });

    this.applyDictionarySourceFilter(qb, filters);

    const rows = await qb.getRawMany<{ id: number; addedAt: Date | string; priorityRank: string | number }>();
    if (rows.length === 0) return null;

    // Пріоритет 0: щойно додані слова, які ще жодного разу не проходили
    // повторення (status = NEW) — саме вони мають вилазити першими.
    // Тут навмисно НЕ перемішуємо — сортуємо за addedAt так, щоб
    // найсвіжіше додане слово було найпершим.
    const newRows = rows
      .filter((r) => Number(r.priorityRank) === 0)
      .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime());
    const newIds = newRows.map((r) => r.id);

    // Пріоритет 1: прострочені по SRS повторення (включно з тими, що
    // недавно позначили "не знаю" — після закінчення їхнього кулдауну
    // вони природно потрапляють саме сюди, а не в самий початок).
    const dueIds = rows.filter((r) => Number(r.priorityRank) === 1).map((r) => r.id);

    // Пріоритет 2: ще не due (включно зі свіжо-скинутими "не знаю"
    // словами, поки триває їхній кулдаун).
    const upcomingIds = rows.filter((r) => Number(r.priorityRank) === 2).map((r) => r.id);

    this.shuffleInPlace(dueIds);
    this.shuffleInPlace(upcomingIds);

    const pushRecentToEnd = (ids: number[]) => [
      ...ids.filter((id) => !recentSet.has(id)),
      ...ids.filter((id) => recentSet.has(id)),
    ];

    const orderedIds = [
      ...pushRecentToEnd(newIds),
      ...pushRecentToEnd(dueIds),
      ...pushRecentToEnd(upcomingIds),
    ];

    const batch: DictionaryBatchCache = { orderedIds, cursor: 0 };
    const batchKey = `user:${userId}:dictionary-word-batch:${filterKey}`;
    await this.cacheService.set(batchKey, batch, this.BATCH_TTL);

    return batch;
  }

  private shuffleInPlace<T>(items: T[]): void {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
  }

  private applyDictionarySourceFilter(
    qb: ReturnType<Repository<UserWord>['createQueryBuilder']>,
    filters?: DictionaryFilters,
  ): void {
    // Рівень слова — окрема умова (AND) поверх джерел.
    if (filters?.levels?.length) {
      qb.andWhere(
        'uw."wordId" IN (SELECT lw.id FROM "word" lw WHERE UPPER(TRIM(lw.level)) IN (:...dictLevels))',
        { dictLevels: filters.levels },
      );
    }

    const hasFilters =
      !!filters &&
      ((filters.bookIds?.length ?? 0) > 0 || !!filters.packages || !!filters.manual || !!filters.favoritesOnly);

    if (!hasFilters) return;

    const conditions: string[] = [];
    const params: Record<string, any> = {};

    if (filters!.bookIds.length > 0) {
      conditions.push('(uw."sourceType" = :bookSource AND uw."sourceBookId" IN (:...bookIds))');
      params.bookSource = 'book';
      params.bookIds = filters!.bookIds;
    }

    if (filters!.packages) {
      conditions.push('(uw."sourceType" = :packageSource)');
      params.packageSource = 'package';
    }

    if (filters!.manual) {
      conditions.push('(uw."sourceType" = :manualSource)');
      params.manualSource = 'manual';
    }

    if (filters!.favoritesOnly) {
      conditions.push('(uw."isFavorite" = true)');
    }

    qb.andWhere(`(${conditions.join(' OR ')})`, params);
  }

  private mapDictionaryUserWordToDto(
    uw: UserWord,
    stats: { totalWords: number; learnedWords: number },
  ): any {
    return {
      id: uw.id,
      status: uw.status,
      userTranslation: uw.userTranslation,
      userText: uw.userText,
      isInDictionary: true,
      srsLevel: uw.srsLevel,
      isMastered: uw.status === StudyStatus.LEARNED,
      nextReviewAt: uw.nextReviewAt,
      source: {
        type: uw.sourceType,
        bookId: uw.sourceBookId,
        bookTitle: uw.sourceBookTitle,
      },
      word: {
        id: uw.word.id,
        text: uw.word.text,
        translation: uw.word.translation,
        definitions: uw.word.definitions,
        description: uw.word.description,
        pronunciation: uw.word.pronunciation,
        antonyms: uw.word.antonyms,
        level: uw.word.level,
        examples: uw.word.examples,
        packageId: uw.word.packageId,
        exampleHighlights: uw.word.exampleHighlights,
        type: uw.word.type,
        similarPhrases: uw.word.similarPhrases ?? null,
      },
      category: {
        type: 'dictionary',
        total: stats.totalWords,
        learned: stats.learnedWords,
        position: stats.learnedWords,
      },
    };
  }

  async getDictionaryFilterOptions(userId: number): Promise<{
    books: { id: string; title: string; wordsCount: number }[];
    packageCount: number;
    manualCount: number;
    favoritesCount: number;
    levelCounts: Record<string, number>;
  }> {
    const bookRows = await this.userWordRepo
      .createQueryBuilder('uw')
      .select('uw."sourceBookId"', 'bookId')
      .addSelect('uw."sourceBookTitle"', 'bookTitle')
      .addSelect('COUNT(*)', 'count')
      .where('uw."userId" = :userId', { userId })
      .andWhere('uw."sourceType" = :type', { type: 'book' })
      .groupBy('uw."sourceBookId"')
      .addGroupBy('uw."sourceBookTitle"')
      .getRawMany<{ bookId: number; bookTitle: string | null; count: string }>();

    const packageCount = await this.userWordRepo.count({
      where: { user: { id: userId }, sourceType: 'package' },
    });

    const manualCount = await this.userWordRepo.count({
      where: { user: { id: userId }, sourceType: 'manual' },
    });

    const favoritesCount = await this.userWordRepo.count({
      where: { user: { id: userId }, isFavorite: true },
    });

    // Скільки слів словника кожного рівня — для вибору рівнів у Повторенні.
    const levelRows = await this.userWordRepo
      .createQueryBuilder('uw')
      .innerJoin('uw.word', 'word')
      .select('UPPER(TRIM(word.level))', 'level')
      .addSelect('COUNT(*)', 'count')
      .where('uw."userId" = :userId', { userId })
      .groupBy('UPPER(TRIM(word.level))')
      .getRawMany<{ level: string | null; count: string }>();
    const levelCounts: Record<string, number> = {};
    for (const row of levelRows) {
      if (row.level) levelCounts[row.level] = Number(row.count);
    }

    return {
      books: bookRows.map((r) => ({
        id: String(r.bookId),
        title: r.bookTitle ?? 'Без назви',
        wordsCount: Number(r.count),
      })),
      packageCount,
      manualCount,
      favoritesCount,
      levelCounts,
    };
  }

  async getFilteredDictionaryWordsCount(
    userId: number,
    filters: DictionaryFilters,
  ): Promise<number> {
    const qb = this.userWordRepo
      .createQueryBuilder('uw')
      .innerJoin('uw.word', 'word')
      .where('uw."userId" = :userId', { userId });

    this.applyDictionarySourceFilter(qb, filters);
    return qb.getCount();
  }

  async updateDictionarySrsBatch(
    userId: number,
    items: { id: number; userWordId?: number; success: boolean }[],
  ): Promise<ProgressBatchResult> {
    if (!items || items.length === 0) {
      return { success: true, updatedIds: [], failedIds: [] };
    }

    // 🔧 Денний ліміт повторень. Раніше відповіді в режимі Dictionary Cards
    // його взагалі не списували: застосунок оптимістично показував "+1", а
    // за ~2 с перечитував статус із сервера (де нічого не змінилось) — і
    // лічильник відкочувався назад. Тепер — атомарне списання, як і в
    // updateUserWordProgressBatch (режим "Картки"). Преміум — без ліміту.
    const { granted } = await this.dailyLimitService.reserveSlots(userId, items.length);
    const skippedItems = granted < items.length ? items.slice(granted) : [];
    items = granted < items.length ? items.slice(0, granted) : items;

    if (items.length === 0) {
      return { success: false, updatedIds: [], failedIds: skippedItems.map((i) => i.id) };
    }

    const wordIds = items.map((i) => i.id);
    const updatedIds: number[] = [];
    const failedIds: number[] = skippedItems.map((i) => i.id);

    await this.userWordRepo.manager.transaction(async (em) => {
      const userWords = await em.find(UserWord, {
        where: { word: { id: In(wordIds) }, user: { id: userId } },
        relations: ['word'],
      });
      const byWordId = new Map(userWords.map((uw) => [uw.word.id, uw]));

      for (const item of items) {
        const uw = byWordId.get(item.id);
        if (!uw) {
          failedIds.push(item.id);
          continue;
        }

        if (item.success) {
          uw.srsLevel = Math.min(this.SRS_MAX_LEVEL, uw.srsLevel + 1);
          const days = this.SRS_INTERVAL_DAYS[uw.srsLevel];
          uw.nextReviewAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
          uw.status = StudyStatus.LEARNED;
        } else {
          uw.srsLevel = 0;
          uw.nextReviewAt = new Date(Date.now() + this.WRONG_ANSWER_COOLDOWN_MS);
          uw.status = StudyStatus.LEARNING;
        }

        await em.save(uw);
        updatedIds.push(item.id);
      }

      // Слова з програми (word.packageId) рахуються і в прогресі програми —
      // саме з user_word_progress статистика на головній і відбір карток
      // беруть "вивчено". Раніше Dictionary Cards оновлювали лише словник.
      const programRows = items
        .map((item) => ({ item, uw: byWordId.get(item.id) }))
        .filter(({ uw }) => !!uw && uw.word?.packageId != null)
        .map(({ item }) => ({
          userId,
          wordId: item.id,
          status: item.success ? ProgramStudyStatus.LEARNED : ProgramStudyStatus.LEARNING,
        }));
      if (programRows.length > 0) {
        await em.upsert(UserWordProgress, programRows, ['userId', 'wordId']);
      }
    });

    await this.invalidateStudySessionCache(userId);

    return { success: failedIds.length === 0, updatedIds, failedIds };
  }

  private async getUserDictionaryStats(
    userId: number,
    filters?: DictionaryFilters,
  ): Promise<{ totalWords: number; learnedWords: number }> {
    const totalQb = this.userWordRepo
      .createQueryBuilder('uw')
      .where('uw."userId" = :userId', { userId });
    this.applyDictionarySourceFilter(totalQb, filters);
    const totalWords = await totalQb.getCount();

    const learnedQb = this.userWordRepo
      .createQueryBuilder('uw')
      .where('uw."userId" = :userId', { userId })
      .andWhere('uw.status = :status', { status: StudyStatus.LEARNED });
    this.applyDictionarySourceFilter(learnedQb, filters);
    const learnedWords = await learnedQb.getCount();

    return { totalWords, learnedWords };
  }

  async getUserRandomWordsForStudy(userId: number, category?: string): Promise<any[]> {
  try {
    const cleanCategory = category?.trim();
    if (cleanCategory) {
      return await this.getUserRandomWordsForStudyByCategory(userId, cleanCategory);
    }

    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'level'],
    });
    if (!user || !user.level) {
      this.logger.warn(`User ${userId} not found or has no level selected.`);
      return [];
    }

    const active = await this.resolveActiveProgramType(userId, user.level);
    if (!active) {
      this.logger.warn(
        `Немає невивчених слів для рівня ${user.level}, userId=${userId}`,
      );
      return [];
    }

    const batchKey = `user:${userId}:word-batch:mixed`;
    const batch = await this.cacheService.get<WordBatchCache>(batchKey);

    let slice: any[];

    if (batch && batch.cursor + this.ITEMS_PER_CALL <= batch.words.length) {
      slice = batch.words.slice(batch.cursor, batch.cursor + this.ITEMS_PER_CALL);
      await this.cacheService.set(
        batchKey,
        { words: batch.words, cursor: batch.cursor + this.ITEMS_PER_CALL },
        this.BATCH_TTL,
      );
    } else {
      const newBatch = await this.generateWordBatch(userId, active.packageIds);
      if (newBatch.length === 0) return [];

      await this.cacheService.set(
        batchKey,
        { words: newBatch, cursor: Math.min(this.ITEMS_PER_CALL, newBatch.length) },
        this.BATCH_TTL,
      );

      slice = newBatch.slice(0, this.ITEMS_PER_CALL);
    }

    const withCategory = await this.attachCategoryStats(slice, active);

    return this.refreshDictionaryMembership(userId, withCategory);
  } catch (error) {
    this.logger.error(`Failed to get random words for user ${userId}`, error);
    return [];
  }
}


private async getCategoryStatsForUser(
    userId: number,
    category: string,
  ): Promise<CategoryCounts> {

    const total = await this.wordRepo.count({
      where: { category }
    });

    const learned = await this.wordRepo
      .createQueryBuilder('word')
      .innerJoin(
        UserWordProgress,
        'progress',
        'progress.wordId = word.id AND progress.userId = :userId AND progress.status = :status',
        { userId, status: StudyStatus.LEARNED }
      )
      .where('word.category = :category', { category })
      .getCount();

    return { total, learned, remaining: total - learned };
  }

private async getIdPoolByCategory(
  userId: number,
  category: string,
): Promise<WordIdPool | null> {
  const cacheKey = `user:${userId}:id-pool:category:${category}`;

  const cached = await this.cacheService.get<WordIdPool>(cacheKey);
  if (cached) return cached;

  const rows = await this.wordRepo
    .createQueryBuilder('word')
    .select('word.id', 'id')
    .addSelect('word.partOfSpeech', 'pos')
    .addSelect('word.type', 'type')
    .where('word.category = :category', { category })
    .andWhere(NOT_LEARNED_SQL, { userId, learnedStatus: StudyStatus.LEARNED })
    .getRawMany<{ id: number; pos: string; type: string }>();

  if (rows.length === 0) return null;

  const byPos: Record<string, number[]> = {};
  const phraseIds: number[] = [];

  for (const row of rows) {
    if (row.type === 'phrase' || row.type === 'phrasal_verb') {
      phraseIds.push(row.id);
      continue;
    }
    const pos = row.pos || 'unknown';
    (byPos[pos] ??= []).push(row.id);
  }

  const result: WordIdPool = { byPos, phraseIds };
  await this.cacheService.set(cacheKey, result, this.ID_POOL_TTL);
  return result;
}

private async generateWordBatchByCategory(
  userId: number,
  category: string,
): Promise<any[]> {
  const pool = await this.getIdPoolByCategory(userId, category);
  if (!pool) return [];

  const recentKey = `user:${userId}:recent-shown-words:category:${category}`;
  const recentIds = (await this.cacheService.get<number[]>(recentKey)) ?? [];

  const chosenIds: number[] = [];

  for (let round = 0; round < this.BATCH_SIZE / this.ITEMS_PER_CALL; round++) {
    const triple = this.pickRandomIdsFromPool(pool.byPos, this.ITEMS_PER_CALL, [
      ...recentIds,
      ...chosenIds,
    ]);
    chosenIds.push(...triple);
  }

  if (chosenIds.length === 0 && pool.phraseIds.length > 0) {
    const excludeSet = new Set(recentIds);
    let candidates = pool.phraseIds.filter((id) => !excludeSet.has(id));
    if (candidates.length < this.BATCH_SIZE) candidates = [...pool.phraseIds];

    while (chosenIds.length < this.BATCH_SIZE && candidates.length > 0) {
      const idx = Math.floor(Math.random() * candidates.length);
      chosenIds.push(candidates.splice(idx, 1)[0]);
    }
  } else if (pool.phraseIds.length > 0 && chosenIds.length > 0) {
    const excludeSet = new Set(recentIds);
    let phraseCandidates = pool.phraseIds.filter((id) => !excludeSet.has(id));
    if (phraseCandidates.length === 0) phraseCandidates = pool.phraseIds;

    const phrasePick = phraseCandidates[Math.floor(Math.random() * phraseCandidates.length)];
    const replaceIndex = Math.floor(Math.random() * chosenIds.length);
    chosenIds[replaceIndex] = phrasePick;
  }

  if (chosenIds.length === 0) return [];

  const words = await this.wordRepo
    .createQueryBuilder('word')
    .leftJoinAndSelect('word.userWords', 'userWord', 'userWord.userId = :userId', { userId })
    .whereInIds(chosenIds)
    .getMany();

  await this.ensureExampleHighlightsBatch(words);

  const orderMap = new Map(chosenIds.map((id, idx) => [id, idx]));
  words.sort((a, b) => orderMap.get(a.id)! - orderMap.get(b.id)!);

  const updatedRecent = [...chosenIds, ...recentIds].slice(0, this.RECENT_SHOWN_MAX);
  await this.cacheService.set(recentKey, updatedRecent, this.BATCH_TTL);

  return words.map((word) => this.mapToUserWordDto(word));
}

private async getUserRandomWordsForStudyByCategory(
  userId: number,
  category: string,
): Promise<any[]> {
  const stats = await this.getCategoryStatsForUser(userId, category);

  if (stats.remaining <= 0) {
    this.logger.warn(
      `Немає невивчених слів у категорії "${category}" для userId=${userId}`,
    );
    return [];
  }

  const batchKey = `user:${userId}:word-batch:category:${category}`;
  const batch = await this.cacheService.get<WordBatchCache>(batchKey);

  let slice: any[];

  if (batch && batch.cursor + this.ITEMS_PER_CALL <= batch.words.length) {
    slice = batch.words.slice(batch.cursor, batch.cursor + this.ITEMS_PER_CALL);
    await this.cacheService.set(
      batchKey,
      { words: batch.words, cursor: batch.cursor + this.ITEMS_PER_CALL },
      this.BATCH_TTL,
    );
  } else {
    const newBatch = await this.generateWordBatchByCategory(userId, category);
    if (newBatch.length === 0) return [];

    await this.cacheService.set(
      batchKey,
      { words: newBatch, cursor: Math.min(this.ITEMS_PER_CALL, newBatch.length) },
      this.BATCH_TTL,
    );

    slice = newBatch.slice(0, this.ITEMS_PER_CALL);
  }

  const withCategory = slice.map((item) => ({
    ...item,
    category: {
      type: category,
      total: stats.total,
      learned: stats.learned,
      position: stats.learned,
    },
  }));

  return this.refreshDictionaryMembership(userId, withCategory);
}


  private async attachCategoryStats(
    words: any[],
    active: ActiveProgramType,
  ): Promise<any[]> {
    return words.map((item) => ({
      ...item,
      category: {
        type: item.word?.type || 'word',
        total: active.total,
        learned: active.learned,
        position: active.learned,
      },
    }));
  }

  private async refreshDictionaryMembership(
    userId: number,
    items: any[],
  ): Promise<any[]> {
    if (!items || items.length === 0) return items;

    const wordIds = items
      .map((item) => item.word?.id)
      .filter((id): id is number => typeof id === 'number');

    if (wordIds.length === 0) return items;

    const liveUserWords = await this.userWordRepo.find({
      where: { user: { id: userId }, word: { id: In(wordIds) } },
      relations: ['word'],
    });

    const byWordId = new Map(liveUserWords.map((uw) => [uw.word.id, uw]));

    return items.map((item) => {
      const wordId = item.word?.id;
      const liveUserWord = typeof wordId === 'number' ? byWordId.get(wordId) : undefined;

      return {
        ...item,
        id: liveUserWord?.id ?? null,
        status: liveUserWord?.status ?? StudyStatus.NEW,
        userTranslation: liveUserWord?.userTranslation ?? null,
        userText: liveUserWord?.userText ?? null,
        isInDictionary: !!liveUserWord,
      };
    });
  }

 private async resolveActiveProgramType(
    userId: number,
    level: string,
  ): Promise<ActiveProgramType | null> {
    const cacheKey = `user:${userId}:active-package-v6:${level}`;

    const cached = await this.cacheService.get<ActiveProgramType | null>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const accesses = await this.programAccessRepo.find({ where: { userId } });
    let accessedPackageIds = accesses.map((a) => a.packageId);

    if (accessedPackageIds.length === 0) {
      await this.cacheService.set(cacheKey, null, 60);
      return null;
    }

    if (level && level !== 'Всі') {
      const packagesAtLevel = await this.programRepo.find({
        where: { id: In(accessedPackageIds), level },
      });
      accessedPackageIds = packagesAtLevel.map((p) => p.id);

      if (accessedPackageIds.length === 0) {
        await this.cacheService.set(cacheKey, null, 60);
        return null;
      }
    }

    const overallTotal = await this.wordRepo.count({
      where: { packageId: In(accessedPackageIds) }
    });

    const overallLearned = await this.wordRepo
      .createQueryBuilder('word')
      .innerJoin(
        UserWordProgress,
        'progress',
        'progress.wordId = word.id AND progress.userId = :userId AND progress.status = :status',
        { userId, status: StudyStatus.LEARNED }
      )
      .where('word.packageId IN (:...packageIds)', { packageIds: accessedPackageIds })
      .getCount();

    if (overallTotal - overallLearned <= 0) {
      await this.cacheService.set(cacheKey, null, 60);
      return null;
    }

    const result: ActiveProgramType = {
      packageIds: accessedPackageIds,
      total: overallTotal,
      learned: overallLearned,
    };
    await this.cacheService.set(cacheKey, result, this.ACTIVE_TYPE_TTL);
    return result;
  }

  private async generateWordBatch(
    userId: number,
    packageIds: number[],
  ): Promise<any[]> {
    const pool = await this.getIdPoolByPos(userId, packageIds);
    if (!pool) return [];

    const recentKey = `user:${userId}:recent-shown-words`;
    const recentIds = (await this.cacheService.get<number[]>(recentKey)) ?? [];

    const chosenIds: number[] = [];

    for (let round = 0; round < this.BATCH_SIZE / this.ITEMS_PER_CALL; round++) {
      const triple = this.pickRandomIdsFromPool(pool.byPos, this.ITEMS_PER_CALL, [
        ...recentIds,
        ...chosenIds,
      ]);
      chosenIds.push(...triple);
    }

    if (chosenIds.length === 0 && pool.phraseIds.length > 0) {
      const excludeSet = new Set(recentIds);
      let candidates = pool.phraseIds.filter((id) => !excludeSet.has(id));
      if (candidates.length < this.BATCH_SIZE) candidates = [...pool.phraseIds];

      while (chosenIds.length < this.BATCH_SIZE && candidates.length > 0) {
        const idx = Math.floor(Math.random() * candidates.length);
        chosenIds.push(candidates.splice(idx, 1)[0]);
      }
    } else if (pool.phraseIds.length > 0 && chosenIds.length > 0) {
      const excludeSet = new Set(recentIds);
      let phraseCandidates = pool.phraseIds.filter((id) => !excludeSet.has(id));
      if (phraseCandidates.length === 0) phraseCandidates = pool.phraseIds;

      const phrasePick = phraseCandidates[Math.floor(Math.random() * phraseCandidates.length)];
      const replaceIndex = Math.floor(Math.random() * chosenIds.length);
      chosenIds[replaceIndex] = phrasePick;
    }

    if (chosenIds.length === 0) return [];

    const words = await this.wordRepo
      .createQueryBuilder('word')
      .leftJoinAndSelect('word.userWords', 'userWord', 'userWord.userId = :userId', { userId })
      .whereInIds(chosenIds)
      .getMany();

    await this.ensureExampleHighlightsBatch(words);

    const orderMap = new Map(chosenIds.map((id, idx) => [id, idx]));
    words.sort((a, b) => orderMap.get(a.id)! - orderMap.get(b.id)!);

    const updatedRecent = [...chosenIds, ...recentIds].slice(0, this.RECENT_SHOWN_MAX);
    await this.cacheService.set(recentKey, updatedRecent, this.BATCH_TTL);

    return words.map((word) => this.mapToUserWordDto(word));
  }

  private async getIdPoolByPos(
    userId: number,
    packageIds: number[],
  ): Promise<WordIdPool | null> {
    const cacheKey = `user:${userId}:id-pool:mixed:v2:${packageIds.join('-')}`;

    const cached = await this.cacheService.get<WordIdPool>(cacheKey);
    if (cached) return cached;

    const rows = await this.wordRepo
      .createQueryBuilder('word')
      .select('word.id', 'id')
      .addSelect('word.partOfSpeech', 'pos')
      .addSelect('word.type', 'type')
      .where('word.packageId IN (:...packageIds)', { packageIds })
      .andWhere(NOT_LEARNED_SQL, { userId, learnedStatus: StudyStatus.LEARNED })
      .getRawMany<{ id: number; pos: string; type: string }>();

    if (rows.length === 0) return null;

    const byPos: Record<string, number[]> = {};
    const phraseIds: number[] = [];

    for (const row of rows) {
      if (row.type === 'phrase' || row.type === 'phrasal_verb') {
        phraseIds.push(row.id);
        continue;
      }
      const pos = row.pos || 'unknown';
      (byPos[pos] ??= []).push(row.id);
    }

    const result: WordIdPool = { byPos, phraseIds };
    await this.cacheService.set(cacheKey, result, this.ID_POOL_TTL);
    return result;
  }


  private pickRandomIdsFromPool(
    pool: Record<string, number[]>,
    limit: number,
    excludeIds: number[],
  ): number[] {
    const excludeSet = new Set(excludeIds);
    const result: number[] = [];
    const usedFromThisPick = new Set<number>();

    for (const pos of this.POS_PRIORITY) {
      if (result.length >= limit) break;
      const candidates = (pool[pos] ?? []).filter(
        (id) => !excludeSet.has(id) && !usedFromThisPick.has(id),
      );
      if (candidates.length === 0) continue;

      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      result.push(pick);
      usedFromThisPick.add(pick);
    }

    if (result.length < limit) {
      const allIds = Object.values(pool).flat();
      let fillerCandidates = allIds.filter(
        (id) => !usedFromThisPick.has(id) && !excludeSet.has(id),
      );

      if (fillerCandidates.length === 0) {
        fillerCandidates = allIds.filter((id) => !usedFromThisPick.has(id));
      }

      while (result.length < limit && fillerCandidates.length > 0) {
        const idx = Math.floor(Math.random() * fillerCandidates.length);
        const pick = fillerCandidates.splice(idx, 1)[0];
        result.push(pick);
        usedFromThisPick.add(pick);
      }
    }

    return result;
  }

  private mapToUserWordDto(word: Word): any {
    const existingUserWord = word.userWords && word.userWords[0];

    return {
      id: existingUserWord?.id || null,
      status: existingUserWord?.status || StudyStatus.NEW,
      userTranslation: existingUserWord?.userTranslation || null,
      userText: existingUserWord?.userText || null,
      isInDictionary: !!existingUserWord,
      word: {
        id: word.id,
        text: word.text,
        translation: word.translation,
        definitions: word.definitions,
        description: word.description,
        pronunciation: word.pronunciation,
        antonyms: word.antonyms,
        level: word.level,
        examples: word.examples,
        packageId: word.packageId,
        exampleHighlights: word.exampleHighlights,
        type: word.type,
        similarPhrases: word.similarPhrases ?? null,
      },
    };
  }

  computeExampleHighlights(word: Word): Array<{ start: number; end: number } | null> {
    return computeExampleHighlights(word);
  }

  async ensureExampleHighlights(word: Word): Promise<Word> {
    if (word.exampleHighlights !== null && word.exampleHighlights !== undefined) {
      return word;
    }
    if (!word.examples || word.examples.length === 0) {
      return word;
    }

    const computed = this.computeExampleHighlights(word);
    word.exampleHighlights = computed;

    try {
      await this.wordRepo.update(word.id, { exampleHighlights: computed });
      this.logger.log(`[HIGHLIGHTS] Обчислено та збережено exampleHighlights для word.id=${word.id} (${word.text})`);
    } catch (error) {
      this.logger.error(`[HIGHLIGHTS] Не вдалося зберегти exampleHighlights для word.id=${word.id}`, error);
    }

    return word;
  }

  async ensureExampleHighlightsBatch(words: Word[]): Promise<Word[]> {
    return Promise.all(words.map((w) => this.ensureExampleHighlights(w)));
  }

  async setExampleHighlightsManually(
    id: number,
    highlights: Array<{ start: number; end: number } | null>,
  ): Promise<{ success: boolean; word: Word }> {
    const word = await this.wordRepo.findOne({ where: { id } });
    if (!word) throw new NotFoundException('Слово не знайдено');

    word.exampleHighlights = highlights;
    const saved = await this.wordRepo.save(word);

    await Promise.all([
      this.cacheService.clear(WordService.ALL_WORDS_CACHE_KEY),
      this.cacheService.clear(WordService.ALL_WORDS_SHORT_CACHE_KEY),
      this.cacheService.clear(this.getWordByIdCacheKey(id)),
    ]);

    return { success: true, word: saved };
  }

  async recomputeExampleHighlights(id: number): Promise<{ success: boolean; word: Word }> {
    const word = await this.wordRepo.findOne({ where: { id } });
    if (!word) throw new NotFoundException('Слово не знайдено');

    word.exampleHighlights = this.computeExampleHighlights(word);
    const saved = await this.wordRepo.save(word);

    await Promise.all([
      this.cacheService.clear(WordService.ALL_WORDS_CACHE_KEY),
      this.cacheService.clear(WordService.ALL_WORDS_SHORT_CACHE_KEY),
      this.cacheService.clear(this.getWordByIdCacheKey(id)),
    ]);

    return { success: true, word: saved };
  }

  async clearAllData(): Promise<{ status: string }> {
    this.logger.warn('☢️ ADMIN: Full DB wipe initiated');

    try {
      await this.wordRepo.query(`SET session_replication_role = 'replica';`);
      await this.wordRepo.query(`TRUNCATE TABLE "user_word" RESTART IDENTITY CASCADE;`);
      await this.wordRepo.query(`TRUNCATE TABLE "word" RESTART IDENTITY CASCADE;`);
      await this.wordRepo.query(`SET session_replication_role = 'origin';`);

      await this.cacheService.clearByPattern('words:*');
      await this.cacheService.clearByPattern('user:*:words:*');
      await this.cacheService.clearByPattern('word:*');

      this.logger.warn('☢️ ADMIN: Full DB wipe completed');
      return { status: 'success' };
    } catch (error) {
      this.logger.error('ADMIN: Full wipe failed', error);
      return { status: 'error' };
    }
  }

  private attachUserFieldsToWord(userWords: UserWord[]): void {
    for (const uw of userWords) {
      const w = uw.word as WordWithUserTranslation;
      w.userTranslation = uw.userTranslation || null;
      w.userText = uw.userText || null;
    }
  }

  async deleteWordsByDate(
    date: Date,
    direction: 'before' | 'after' = 'before',
  ): Promise<{ success: boolean; deletedCount: number; message: string }> {
    this.logger.warn(
      `ADMIN: Deleting words with createdAt ${direction} ${date.toISOString()}`,
    );

    const qb = this.wordRepo.createQueryBuilder('word');
    if (direction === 'before') {
      qb.where('word.createdAt <= :date', { date });
    } else {
      qb.where('word.createdAt >= :date', { date });
    }

    const wordsToDelete = await qb.getMany();

    if (wordsToDelete.length === 0) {
      return {
        success: true,
        deletedCount: 0,
        message: 'Слів для видалення за цією датою не знайдено',
      };
    }

    const wordIds = wordsToDelete.map((w) => w.id);

    await this.userWordRepo.delete({ word: { id: In(wordIds) } });

    const deleteResult = await this.wordRepo.delete(wordIds);
    const deletedCount = deleteResult.affected || 0;

    await Promise.all([
      this.cacheService.clear(WordService.ALL_WORDS_CACHE_KEY),
      this.cacheService.clear(WordService.ALL_WORDS_SHORT_CACHE_KEY),
      this.cacheService.clearByPattern('word:*'),
      this.cacheService.clearByPattern('user:*:words:*'),
    ]);

    const directionLabel =
      direction === 'before' ? 'додані до' : 'додані після';

    this.logger.log(
      `ADMIN: Successfully deleted ${deletedCount} words (createdAt ${direction} ${date.toISOString()})`,
    );

    return {
      success: true,
      deletedCount,
      message: `Успішно видалено ${deletedCount} слів (${directionLabel} ${date.toLocaleDateString('uk-UA')})`,
    };
  }

  async previewWordsByPattern(
    pattern: string,
    mode: WordPatternMode = 'starts_with',
  ): Promise<{ count: number; sample: { id: number; text: string }[] }> {
    const cleanPattern = pattern.trim().toLowerCase();
    if (!cleanPattern) {
      throw new BadRequestException('Параметр "pattern" не може бути порожнім');
    }

    const qb = this.buildPatternQuery(cleanPattern, mode);

    const count = await qb.getCount();
    const sample = await qb
      .clone()
      .orderBy('word.text', 'ASC')
      .limit(50)
      .getMany();

    return {
      count,
      sample: sample.map((w) => ({ id: w.id, text: w.text })),
    };
  }

  async deleteWordsByPattern(
    pattern: string,
    mode: WordPatternMode = 'starts_with',
  ): Promise<{ success: boolean; deletedCount: number; message: string }> {
    const cleanPattern = pattern.trim().toLowerCase();
    if (!cleanPattern) {
      throw new BadRequestException('Параметр "pattern" не може бути порожнім');
    }

    this.logger.warn(
      `ADMIN: Deleting words by pattern "${cleanPattern}" (mode: ${mode})`,
    );

    const qb = this.buildPatternQuery(cleanPattern, mode);
    const wordsToDelete = await qb.getMany();

    if (wordsToDelete.length === 0) {
      return {
        success: true,
        deletedCount: 0,
        message: `Слів за патерном "${cleanPattern}" не знайдено`,
      };
    }

    const wordIds = wordsToDelete.map((w) => w.id);

    await this.userWordRepo.delete({ word: { id: In(wordIds) } });

    const deleteResult = await this.wordRepo.delete(wordIds);
    const deletedCount = deleteResult.affected || 0;

    await Promise.all([
      this.cacheService.clear(WordService.ALL_WORDS_CACHE_KEY),
      this.cacheService.clear(WordService.ALL_WORDS_SHORT_CACHE_KEY),
      this.cacheService.clearByPattern('word:*'),
      this.cacheService.clearByPattern('user:*:words:*'),
    ]);

    this.logger.log(
      `ADMIN: Successfully deleted ${deletedCount} words matching pattern "${cleanPattern}" (mode: ${mode})`,
    );

    return {
      success: true,
      deletedCount,
      message: `Успішно видалено ${deletedCount} слів за патерном "${cleanPattern}"`,
    };
  }

  private buildPatternQuery(pattern: string, mode: WordPatternMode) {
    const qb = this.wordRepo.createQueryBuilder('word');

    if (mode === 'starts_with') {
      const withSpace = pattern.endsWith(' ') ? pattern : `${pattern} `;
      qb.where('LOWER(word.text) LIKE :pattern', { pattern: `${withSpace}%` });
    } else if (mode === 'contains') {
      qb.where('LOWER(word.text) LIKE :pattern', { pattern: `%${pattern}%` });
    } else {
      qb.where('LOWER(word.text) = :pattern', { pattern });
    }

    return qb;
  }

  async deleteUnassignedWords(): Promise<{ success: boolean; deletedCount: number; message: string }> {
    this.logger.warn('ADMIN: Initiating deletion of all unassigned words (packageId IS NULL OR 0)');

    const wordsToDelete = await this.wordRepo
      .createQueryBuilder('word')
      .where('word.packageId IS NULL')
      .orWhere('word.packageId = 0')
      .getMany();

    if (wordsToDelete.length === 0) {
      return { success: true, deletedCount: 0, message: 'Немає слів без пакету для видалення' };
    }

    const wordIds = wordsToDelete.map((w) => w.id);

    await this.userWordRepo.delete({ word: { id: In(wordIds) } });

    const deleteResult = await this.wordRepo.delete(wordIds);
    const deletedCount = deleteResult.affected || 0;

    await Promise.all([
      this.cacheService.clear(WordService.ALL_WORDS_CACHE_KEY),
      this.cacheService.clear(WordService.ALL_WORDS_SHORT_CACHE_KEY),
      this.cacheService.clearByPattern('word:*'),
      this.cacheService.clearByPattern('user:*:words:*'),
    ]);

    this.logger.log(`ADMIN: Successfully deleted ${deletedCount} unassigned words`);

    return {
      success: true,
      deletedCount,
      message: `Успішно видалено ${deletedCount} слів без прив'язки до пакету`,
    };
  }

}

interface WordBatchCache {
  words: any[];
  cursor: number;
}

interface DictionaryBatchCache {
  orderedIds: number[];
  cursor: number;
}