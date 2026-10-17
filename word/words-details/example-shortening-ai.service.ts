import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { OpenAI } from 'openai/client.js';
import { Word } from '../word.entity';
import { CacheService } from 'src/cache/cache.service';
import { WordService } from '../word.service';
import {
  MAX_EXAMPLE_LENGTH,
  isWithinExampleLimit,
  enforceExampleArrayConstraints,
} from '../words-details/example-length.util';

export type ExamplesShorteningMode = 'over_limit' | 'all';

export type ExamplesShorteningItemStatus =
  | 'ready'        // AI запропонував нові приклади — очікує рішення адміна
  | 'unchanged'    // AI вважає, що приклади вже відповідають вимогам
  | 'error'        // не вдалося обробити слово (AI-помилка, невалідна відповідь)
  | 'approved'     // адмін затвердив і зміни вже застосовано в БД
  | 'rejected';    // адмін відхилив пропозицію

export interface ExamplesShorteningDraftItem {
  wordId: number;
  text: string;
  oldExamples: string[];
  newExamples: string[] | null;
  status: ExamplesShorteningItemStatus;
  errorMessage?: string;
}

export type ExamplesShorteningJobState = 'idle' | 'running' | 'paused' | 'done' | 'error';

interface ExamplesShorteningJob {
  state: ExamplesShorteningJobState;
  mode: ExamplesShorteningMode | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  totalCandidates: number;
  totalBatches: number;
  processedBatches: number;
  items: Map<number, ExamplesShorteningDraftItem>;
  errorMessage?: string;
  // 🟢 НОВЕ: повний список кандидатів цього прогону та його покоління.
  // Зберігаються НА ВЕСЬ час життя job (а не лише під час одного виклику
  // runJobInBackground), щоб "Продовжити" після паузи (вичерпання ліміту
  // AI) міг просто дорахувати те, що лишилось, замість того, щоб
  // перезапускати аналіз "з нуля" і витрачати AI-запити повторно на вже
  // готові слова.
  candidates: Word[];
  epoch: number;
}

export interface ExamplesShorteningStatusResponse {
  state: ExamplesShorteningJobState;
  mode: ExamplesShorteningMode | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  progress: {
    totalCandidates: number;
    totalBatches: number;
    processedBatches: number;
  };
  counts: Record<ExamplesShorteningItemStatus, number>;
  items: ExamplesShorteningDraftItem[];
  errorMessage?: string;
}

/**
 * Маркер "квоту AI вичерпано". На відміну від звичайної помилки пачки
 * (яка стосується лише тих 20 слів і не заважає обробити решту), ця
 * помилка означає, що ВЕСЬ подальший прогін безглуздий — кожна наступна
 * пачка теж миттєво впаде з тією ж причиною. Тому її ніколи не
 * "проковтуємо" на рівні однієї пачки: вона піднімається аж до
 * runJobInBackground, яка одразу зупиняє весь job замість того, щоб
 * позначати сотні слів фейковим статусом "error".
 */
class AiQuotaExhaustedError extends Error {}

/**
 * Адмінський пакетний сервіс: проходить по всіх словах у глобальній
 * таблиці Word (саме там зберігаються examples — UserWord лише
 * посилається на Word і власного тексту прикладів не має), і одним
 * "довгим" запитом на пачку з кількох десятків слів просить AI
 * скоротити приклади до жорсткого ліміту символів та розставити
 * часову прогресію (теперішній → минулий → майбутній).
 *
 * Робочий процес навмисно двоетапний:
 *   1) startAnalysis()  — рахує все, зберігає ЧЕРНЕТКУ в пам'яті, нічого
 *      не пише в БД.
 *   2) getStatus()      — адмін дивиться повний список запропонованих
 *      змін (старі приклади vs нові).
 *   3) approveChanges() / rejectChanges() — і лише після явного
 *      підтвердження зміни потрапляють у БД.
 */
@Injectable()
export class ExampleShorteningAiService {
  private readonly logger = new Logger(ExampleShorteningAiService.name);

  private static readonly WORDS_PER_AI_REQUEST = 20;

  // 🔧 НАЛАШТУВАННЯ ПІД ВАШ ТАРИФ OPENAI (можна змінити без пересборки
  // логіки — просто через змінні середовища). Причина падіння "18/124
  // запитів вичерпано" — це майже завжди ліміт швидкості (RPM/TPM) на
  // вашому тарифі, а не буквальна відсутність коштів: за короткий час
  // було відправлено забагато одночасних/послідовних запитів. Зменшення
  // паралельності й пауза між пачками дозволяють довше "протриматись"
  // у межах ліміту й обробити більшу частину бази за один прогін,
  // ніж раніше (concurrency=3 без жодної паузи).
  private static readonly BATCH_CONCURRENCY = Number(process.env.EXAMPLES_SHORTENING_CONCURRENCY) || 2;
  private static readonly INTER_CHUNK_DELAY_MS = Number(process.env.EXAMPLES_SHORTENING_DELAY_MS) || 1500;
  private static readonly MAX_BATCH_ATTEMPTS = 2;

  private static openAiQuotaBlockedUntil: number | null = null;
  private static readonly QUOTA_COOLDOWN_MS = 5 * 60 * 1000;

  private readonly openai: OpenAI;

  private job: ExamplesShorteningJob = this.emptyJob();

  // 🟢 НОВЕ: таймер автоматичного продовження після паузи через ліміт AI.
  // Коли ліміт мине, аналіз сам відновиться з того місця, де зупинився —
  // адміну не потрібно вручну повертатись і тиснути "Продовжити" щоразу,
  // якщо велика база вимагає кількох "хвиль" обробки поспіль.
  private autoResumeTimer: ReturnType<typeof setTimeout> | null = null;

  // 🔒 Захист від "гонки" між запусками. Кожен startAnalysis()/повне
  // rejectChanges() збільшує лічильник поколінь. Фоновий цикл обробки
  // (runJobInBackground/processBatch) перед КОЖНИМ записом у this.job
  // звіряє своє покоління з поточним — якщо вони розійшлися (бо
  // паралельно стартував новий аналіз або хтось усе скинув), старий
  // цикл просто тихо припиняє писати результати. Без цього застарілий
  // фоновий прогін міг непомітно "затирати" щойно почату нову перевірку
  // тими самими даними, що й спричиняло враження "не перевіряє повторно".
  private currentEpoch = 0;

  constructor(
    @InjectRepository(Word) private readonly wordRepo: Repository<Word>,
    private readonly cacheService: CacheService,
    private readonly wordService: WordService,
  ) {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  private emptyJob(): ExamplesShorteningJob {
    return {
      state: 'idle',
      mode: null,
      startedAt: null,
      finishedAt: null,
      totalCandidates: 0,
      totalBatches: 0,
      processedBatches: 0,
      items: new Map(),
      candidates: [],
      epoch: 0,
    };
  }

  private clearAutoResumeTimer(): void {
    if (this.autoResumeTimer) {
      clearTimeout(this.autoResumeTimer);
      this.autoResumeTimer = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ────────────────────────────────────────────────────────────────
  // Публічний API для контролера
  // ────────────────────────────────────────────────────────────────

  /**
   * Запускає фонову пакетну обробку. Якщо задача вже виконується —
   * просто повертає поточний статус, не запускаючи другу паралельно.
   *
   * mode:
   *  - 'over_limit' (за замовчуванням) — обробляти лише слова, у яких
   *     ХОЧА Б ОДИН приклад довший за ліміт. Дешевше й швидше.
   *  - 'all' — прогнати взагалі всі слова з непорожніми examples, щоб
   *     заодно виправити й часову прогресію там, де довжина вже ОК,
   *     але пари речень не йдуть теперішній/минулий/майбутній.
   */
  async startAnalysis(mode: ExamplesShorteningMode = 'over_limit'): Promise<ExamplesShorteningStatusResponse> {
    // 🔧 ВИПРАВЛЕНО: раніше тут було "if (this.job.state === 'running') return
    // this.getStatus();" — якщо попередній прогін з якоїсь причини "завис"
    // (наприклад, застряг мережевий виклик до AI), користувач НІКОЛИ не міг
    // запустити новий аналіз повторно: кнопка "Старт" просто мовчки
    // повертала той самий старий/незмінний статус.
    //
    // Тепер "Старт" ЗАВЖДИ починає дійсно новий, чистий прогін. Захист від
    // того, що старий фоновий цикл (якщо він усе ще виконується) продовжить
    // писати вже застарілі результати в нову чернетку, забезпечує лічильник
    // поколінь (epoch) — старий цикл побачить, що покоління змінилось, і
    // сам себе тихо зупинить (див. runJobInBackground/processBatch нижче).
    this.clearAutoResumeTimer(); // новий "старт з нуля" скасовує будь-яке заплановане автопродовження старого job
    const epoch = ++this.currentEpoch;

    if (this.job.state === 'running' || this.job.state === 'paused') {
      this.logger.warn(
        `Запускаю новий аналіз (покоління ${epoch}) поверх попереднього стану "${this.job.state}" — ` +
        `попередній прогін буде проігноровано і не зможе більше писати результати.`,
      );
    }

    // 🔧 НОВЕ: перевіряємо квоту ДО того, як лізти в БД і формувати пачки.
    // Раніше при вичерпаній квоті job все одно стартував, і КОЖНА пачка
    // одразу падала з однаковою помилкою — десятки дублікатів у логах і
    // марна робота. Тепер, якщо квота вже точно заблокована, повертаємо
    // чіткий job-рівня статус "error" одразу, без жодного запиту до AI.
    if (this.isQuotaBlocked()) {
      this.job = {
        ...this.emptyJob(),
        state: 'error',
        mode,
        startedAt: new Date(),
        finishedAt: new Date(),
        errorMessage: this.buildQuotaMessage(),
        epoch,
      };
      this.logger.warn(`Відмовлено в запуску аналізу (покоління ${epoch}): ${this.job.errorMessage}`);
      return this.getStatus();
    }

    const candidates = await this.loadCandidates(mode);

    this.job = {
      ...this.emptyJob(),
      state: 'running',
      mode,
      startedAt: new Date(),
      totalCandidates: candidates.length,
      totalBatches: Math.ceil(candidates.length / ExampleShorteningAiService.WORDS_PER_AI_REQUEST),
      candidates,
      epoch,
    };

    if (candidates.length === 0) {
      this.job.state = 'done';
      this.job.finishedAt = new Date();
      return this.getStatus();
    }

    // Запускаємо обробку у фоні — не блокуємо HTTP-відповідь на весь час аналізу.
    this.runJobInBackground(epoch).catch((error) => {
      if (epoch !== this.currentEpoch) return; // застарілий прогін — ігноруємо навіть помилку
      this.logger.error('Фонова задача скорочення прикладів впала', error);
      this.job.state = 'error';
      this.job.finishedAt = new Date();
      this.job.errorMessage = error?.message || 'Невідома помилка';
    });

    return this.getStatus();
  }

  /**
   * Продовжує ПРИЗУПИНЕНИЙ (через ліміт AI) аналіз з того самого місця:
   * дорахує лише слова, яких ще немає в чернетці (job.items), не чіпаючи
   * вже готові. Викликається як вручну (кнопка "Продовжити"), так і
   * автоматично таймером після завершення кулдауну (scheduleAutoResume).
   */
  async resumeAnalysis(): Promise<ExamplesShorteningStatusResponse> {
    this.clearAutoResumeTimer();

    if (this.job.state !== 'paused') {
      throw new BadRequestException(
        `Немає призупиненого аналізу для продовження (поточний стан: "${this.job.state}").`,
      );
    }

    // 🔧 ВИПРАВЛЕНО: раніше тут була перевірка "якщо ще заблоковано за
    // старим таймером — відмовити". Але для білінгової помилки блокування
    // штучно виставляється на 24 години наперед (бо вона сама не минає) —
    // і якщо адмін ПОПОВНИВ БАЛАНС і натиснув "Продовжити" вже за 5 хвилин,
    // ця перевірка тупо відмовляла б йому ще 23 години 55 хвилин, хоча
    // проблему вже вирішено. Виклик resumeAnalysis() — це і є сигнал
    // "спробуй просто зараз", тож примусово скидаємо блокування й реально
    // пробуємо: якщо причина ще актуальна, наступний же запит миттєво й
    // точно визначить це заново (втрата — один зайвий виклик, не критично).
    ExampleShorteningAiService.openAiQuotaBlockedUntil = null;
    ExampleShorteningAiService.openAiQuotaKind = null;

    const epoch = this.job.epoch; // те саме покоління — це продовження, а не новий прогін
    this.job.state = 'running';
    this.job.errorMessage = undefined;

    this.runJobInBackground(epoch).catch((error) => {
      if (epoch !== this.currentEpoch) return;
      this.logger.error('Фонова задача скорочення прикладів впала під час продовження', error);
      this.job.state = 'error';
      this.job.finishedAt = new Date();
      this.job.errorMessage = error?.message || 'Невідома помилка';
    });

    return this.getStatus();
  }

  /**
   * Плюс на майбутнє: якщо ліміт AI скине через N секунд, самі
   * викликаємо resumeAnalysis(), щоб адміну не довелось сидіти й вручну
   * тиснути кнопку кожні кілька хвилин, поки триває обробка великої бази.
   */
  private scheduleAutoResume(epoch: number): void {
    this.clearAutoResumeTimer();

    // 🔧 КРИТИЧНО: для білінгової помилки (insufficient_quota) АВТОПРОДОВЖЕННЯ
    // НЕ плануємо — вона не мине сама, і таймер лише марно стукав би в AI
    // щоразу, генеруючи ту саму помилку знову й знову. Адмін має сам
    // поповнити баланс і натиснути "Продовжити" вручну.
    if (this.isBillingExhausted()) {
      this.logger.warn(
        `Автопродовження НЕ заплановано (покоління ${epoch}): причина паузи — вичерпання ліміту оплати, а не швидкості. ` +
        `Потрібне ручне втручання (поповнити баланс OpenAI, тоді натиснути "Продовжити").`,
      );
      return;
    }

    const until = ExampleShorteningAiService.openAiQuotaBlockedUntil ?? Date.now();
    const delay = Math.max(1000, until - Date.now() + 2000); // +2с запасу про всяк випадок

    this.autoResumeTimer = setTimeout(() => {
      this.autoResumeTimer = null;
      if (epoch !== this.currentEpoch || this.job.state !== 'paused') return; // хтось уже перезапустив/скинув
      this.logger.log(`🔄 Автоматично продовжую аналіз (покоління ${epoch}) після завершення кулдауну AI.`);
      this.resumeAnalysis().catch((err) => this.logger.error('Автопродовження аналізу впало', err));
    }, delay);
  }

  getStatus(onlyChanged = false): ExamplesShorteningStatusResponse {
    const allItems = Array.from(this.job.items.values()).sort((a, b) => a.wordId - b.wordId);
    const items = onlyChanged ? allItems.filter((i) => i.status === 'ready') : allItems;

    const counts: Record<ExamplesShorteningItemStatus, number> = {
      ready: 0,
      unchanged: 0,
      error: 0,
      approved: 0,
      rejected: 0,
    };
    for (const item of allItems) {
      counts[item.status] += 1;
    }

    return {
      state: this.job.state,
      mode: this.job.mode,
      startedAt: this.job.startedAt,
      finishedAt: this.job.finishedAt,
      progress: {
        totalCandidates: this.job.totalCandidates,
        totalBatches: this.job.totalBatches,
        processedBatches: this.job.processedBatches,
      },
      counts,
      items,
      errorMessage: this.job.errorMessage,
    };
  }

  /**
   * Затверджує запропоновані зміни й записує їх у БД.
   * wordIds не передано → затверджуються ВСІ пункти зі статусом 'ready'.
   */
  async approveChanges(wordIds?: number[]): Promise<{ success: boolean; appliedCount: number; message: string }> {
    if (this.job.state === 'running') {
      throw new BadRequestException(
        'Аналіз ще активно виконується просто зараз — зачекайте, поки з\'явиться пауза або завершення, перед затвердженням.',
      );
    }

    const targets = this.pickTargets(wordIds, 'ready');
    if (targets.length === 0) {
      return { success: true, appliedCount: 0, message: 'Немає елементів зі статусом "ready" для затвердження.' };
    }

    const wordsInDb = await this.wordRepo.find({ where: { id: In(targets.map((t) => t.wordId)) } });
    const wordsById = new Map(wordsInDb.map((w) => [w.id, w]));

    let appliedCount = 0;
    for (const item of targets) {
      const word = wordsById.get(item.wordId);
      if (!word || !item.newExamples) {
        item.status = 'error';
        item.errorMessage = 'Слово не знайдено в БД під час затвердження (можливо, видалено раніше).';
        continue;
      }

      await this.wordRepo.update(word.id, {
        examples: item.newExamples,
        // Приклади змінились — старі highlight-и (підсвітка слова в
        // реченні) вже не відповідають новому тексту, тож скидаємо їх,
        // щоб система порахувала їх заново при наступному читанні слова.
        exampleHighlights: null as any,
      });

      item.status = 'approved';
      appliedCount += 1;
    }

    if (appliedCount > 0) {
      await this.clearWordCaches(targets.map((t) => t.wordId));
    }

    return {
      success: true,
      appliedCount,
      message: `Застосовано оновлені приклади для ${appliedCount} слів.`,
    };
  }

  /**
   * Відхиляє чернетку. wordIds не передано → скидає всю задачу цілком
   * (наступний startAnalysis почне з чистого аркуша).
   */
  rejectChanges(wordIds?: number[]): { success: boolean; rejectedCount: number; message: string } {
    if (!wordIds || wordIds.length === 0) {
      const rejectedCount = this.job.items.size;
      // Бампаємо покоління і тут: якщо фонова обробка попереднього
      // (ще не завершеного) прогону досі виконується, вона побачить
      // невідповідність епохи і перестане писати в щойно очищену
      // чернетку — інакше "скинуте" вікно за секунду знову наповнилось
      // би застарілими результатами.
      this.currentEpoch += 1;
      this.clearAutoResumeTimer(); // повний скид скасовує будь-яке заплановане автопродовження
      this.job = this.emptyJob();
      return {
        success: true,
        rejectedCount,
        message: 'Всю чернетку аналізу відхилено та очищено. Можна запускати новий аналіз.',
      };
    }

    const targets = this.pickTargets(wordIds, 'ready');
    for (const item of targets) {
      item.status = 'rejected';
    }

    return {
      success: true,
      rejectedCount: targets.length,
      message: `Відхилено пропозиції для ${targets.length} слів.`,
    };
  }

  // ────────────────────────────────────────────────────────────────
  // Внутрішня логіка
  // ────────────────────────────────────────────────────────────────

  private pickTargets(
    wordIds: number[] | undefined,
    onlyStatus: ExamplesShorteningItemStatus,
  ): ExamplesShorteningDraftItem[] {
    const all = Array.from(this.job.items.values()).filter((i) => i.status === onlyStatus);
    if (!wordIds || wordIds.length === 0) return all;

    const idSet = new Set(wordIds);
    return all.filter((i) => idSet.has(i.wordId));
  }

  private async loadCandidates(mode: ExamplesShorteningMode): Promise<Word[]> {
    const words = await this.wordRepo
      .createQueryBuilder('word')
      .select(['word.id', 'word.text', 'word.examples'])
      .where('word.examples IS NOT NULL')
      .getMany();

    const withExamples = words.filter((w) => Array.isArray(w.examples) && w.examples.length > 0);

    if (mode === 'all') {
      return withExamples;
    }

    return withExamples.filter((w) =>
      (w.examples as string[]).some((e) => !isWithinExampleLimit(e, MAX_EXAMPLE_LENGTH)),
    );
  }

  /**
   * Обробляє залишок кандидатів поточного job (this.job.candidates мінус
   * ті, що вже є в this.job.items) — тому цю саму функцію безпечно
   * викликати повторно як для першого запуску, так і для продовження
   * після паузи: вона сама порахує, що ще лишилось зробити.
   */
  private async runJobInBackground(epoch: number): Promise<void> {
    while (true) {
      if (epoch !== this.currentEpoch) {
        this.logger.warn(`Прогін покоління ${epoch} перервано: з'явилось новіше покоління ${this.currentEpoch}.`);
        return;
      }

      const remaining = this.job.candidates.filter((w) => !this.job.items.has(w.id));
      if (remaining.length === 0) break;

      const chunkWords = remaining.slice(
        0,
        ExampleShorteningAiService.WORDS_PER_AI_REQUEST * ExampleShorteningAiService.BATCH_CONCURRENCY,
      );
      const chunkOfBatches: Word[][] = [];
      for (let i = 0; i < chunkWords.length; i += ExampleShorteningAiService.WORDS_PER_AI_REQUEST) {
        chunkOfBatches.push(chunkWords.slice(i, i + ExampleShorteningAiService.WORDS_PER_AI_REQUEST));
      }

      try {
        await Promise.all(
          chunkOfBatches.map((batch) => this.processBatch(batch, epoch)),
        );
      } catch (error) {
        if (error instanceof AiQuotaExhaustedError) {
          if (epoch === this.currentEpoch) {
            // 🔧 ВИПРАВЛЕНО: раніше тут виставлявся стан 'error', і єдиний
            // спосіб продовжити — тиснути "Старт" заново, що перезапускало
            // б аналіз "з нуля" (заново обробляючи вже готові слова).
            // Тепер це саме ПАУЗА: прогрес (this.job.items) лишається, а
            // "Продовжити"/автотаймер дораховують тільки залишок.
            this.job.state = 'paused';
            const autoResumeNote = this.isBillingExhausted()
              ? 'Автоматичне продовження ВИМКНЕНО для цієї причини — поповніть баланс і натисніть "Продовжити" вручну.'
              : 'Аналіз продовжиться автоматично, коли ліміт швидкості відновиться — можна закрити вікно й повернутись пізніше.';
            this.job.errorMessage =
              `Призупинено. Готово ${this.job.items.size} з ${this.job.totalCandidates} слів. ${error.message} ${autoResumeNote}`;
            this.logger.warn(
              `⏸ Призупиняю аналіз (покоління ${epoch}): готово ${this.job.items.size}/${this.job.totalCandidates} слів. ${error.message}`,
            );
            this.scheduleAutoResume(epoch);
          } else {
            this.logger.warn(`Прогін покоління ${epoch} впав через ліміт AI, але вже застарілий (поточне покоління ${this.currentEpoch}) — ігнорую.`);
          }
          return;
        }
        throw error; // щось справді неочікуване — нехай спливає до .catch() у startAnalysis/resumeAnalysis
      }

      if (epoch !== this.currentEpoch) return;
      this.job.processedBatches += chunkOfBatches.length;

      // 🔧 НОВЕ: невелика пауза між "хвилями" запитів, щоб не бити в
      // ліміт швидкості (RPM/TPM) одразу знову — саме відсутність такої
      // паузи й концентрація кількох паралельних запитів без жодного
      // стримування й спричиняли швидке вичерпання ліміту після ~18 пачок.
      if (ExampleShorteningAiService.INTER_CHUNK_DELAY_MS > 0) {
        await this.sleep(ExampleShorteningAiService.INTER_CHUNK_DELAY_MS);
      }
    }

    if (epoch !== this.currentEpoch) return;

    this.job.state = 'done';
    this.job.finishedAt = new Date();

    this.logger.log(
      `✅ Аналіз скорочення прикладів завершено (покоління ${epoch}): оброблено ${this.job.totalCandidates} слів у ${this.job.totalBatches} запитах.`,
    );
  }

  private async processBatch(batch: Word[], epoch: number): Promise<void> {
    let results: { items: ExamplesShorteningDraftItem[] } | null = null;

    try {
      const aiResults = await this.requestBatchShortening(batch);
      const aiByWordId = new Map(aiResults.map((r) => [r.wordId, r.examples]));

      const items: ExamplesShorteningDraftItem[] = batch.map((word) => {
        const oldExamples = Array.isArray(word.examples) ? (word.examples as string[]) : [];
        const aiExamples = aiByWordId.get(word.id);

        if (!aiExamples) {
          return {
            wordId: word.id,
            text: word.text,
            oldExamples,
            newExamples: null,
            status: 'error',
            errorMessage: 'AI не повернув результат для цього слова в пачці.',
          };
        }

        const safeExamples = enforceExampleArrayConstraints(aiExamples, MAX_EXAMPLE_LENGTH);
        const isSameAsOld =
          oldExamples.length === safeExamples.length &&
          oldExamples.every((e, idx) => e === safeExamples[idx]);

        return {
          wordId: word.id,
          text: word.text,
          oldExamples,
          newExamples: safeExamples,
          status: isSameAsOld ? 'unchanged' : 'ready',
        };
      });

      results = { items };
    } catch (error: any) {
      if (error instanceof AiQuotaExhaustedError) {
        // Навмисно НЕ логуємо тут і НЕ створюємо per-word "error" записи:
        // причина однакова для всіх слів одразу, і runJobInBackground
        // залогує/поясне це РІВНО ОДИН РАЗ на весь job, а не на кожну пачку.
        throw error;
      }

      this.logger.error(`Пачка з ${batch.length} слів провалилась повністю`, error);
      results = {
        items: batch.map((word) => ({
          wordId: word.id,
          text: word.text,
          oldExamples: Array.isArray(word.examples) ? (word.examples as string[]) : [],
          newExamples: null,
          status: 'error' as const,
          errorMessage: error?.message || 'Помилка AI-запиту для цієї пачки.',
        })),
      };
    }

    // Результат AI-виклику готовий лише ЗАРАЗ (після await) — саме тому
    // перевірку покоління робимо тут, безпосередньо перед записом, а не
    // до виклику AI: інакше застарілий прогін міг би встигнути "проскочити"
    // перевірку до того, як з'явився новіший epoch.
    if (epoch !== this.currentEpoch) {
      this.logger.warn(`Результат пачки з покоління ${epoch} відкинуто — вже виконується новіше покоління ${this.currentEpoch}.`);
      return;
    }

    for (const item of results.items) {
      this.job.items.set(item.wordId, item);
    }
  }

  // 🔧 КРИТИЧНО ВАЖЛИВО: OpenAI повертає ДВІ РІЗНІ причини під однаковим
  // HTTP-статусом 429, і їх не можна лікувати однаково:
  //   - "insufficient_quota" (код помилки саме такий) = на рахунку
  //     закінчились гроші / вичерпано ліміт виставлення рахунків. Це
  //     НІКОЛИ не минає само по собі — жодні секунди очікування не
  //     допоможуть, поки хтось вручну не поповнить баланс на
  //     platform.openai.com/settings/billing. Автоповтор тут — це просто
  //     нескінченний цикл марних невдалих спроб.
  //   - будь-який інший 429 без цього коду = звичайний ліміт швидкості
  //     (RPM/TPM), який дійсно минає сам за секунди-хвилини — тут
  //     автопродовження доречне.
  private static openAiQuotaKind: 'billing' | 'rate_limit' | null = null;

  private isQuotaBlocked(): boolean {
    const until = ExampleShorteningAiService.openAiQuotaBlockedUntil;
    return !!until && Date.now() < until;
  }

  private isBillingExhausted(): boolean {
    return this.isQuotaBlocked() && ExampleShorteningAiService.openAiQuotaKind === 'billing';
  }

  private buildQuotaMessage(): string {
    if (this.isBillingExhausted()) {
      return (
        `Вичерпано ліміт ОПЛАТИ облікового запису OpenAI (insufficient_quota). ` +
        `Це НЕ тимчасовий ліміт швидкості — сам він НЕ мине ні за 5 хвилин, ні пізніше. ` +
        `Потрібно поповнити баланс або підвищити ліміт виставлення рахунків на platform.openai.com/settings/organization/billing, ` +
        `а тоді вручну натиснути "Продовжити".`
      );
    }
    const until = ExampleShorteningAiService.openAiQuotaBlockedUntil ?? 0;
    const secondsLeft = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    return `AI тимчасово недоступний (вичерпано ліміт швидкості запитів). Спробуйте приблизно через ${secondsLeft}с.`;
  }

  private assertOpenAiAvailable(): void {
    if (this.isQuotaBlocked()) {
      throw new AiQuotaExhaustedError(this.buildQuotaMessage());
    }
  }

  private markQuotaExhaustedIfNeeded(error: any): void {
    const isBillingError =
      error?.code === 'insufficient_quota' || error?.error?.code === 'insufficient_quota';
    const isRateLimitError = !isBillingError && error?.status === 429;

    if (!isBillingError && !isRateLimitError) return;

    // Не пере-логуємо й не "продовжуємо" блокування щоразу, коли ще одна
    // паралельна пачка впаде з тією самою причиною в ту саму секунду —
    // саме через це в логах з'являлись дублікати "🚫 ... Блокую на 300с"
    // по двічі підряд (BATCH_CONCURRENCY=2 падали одночасно).
    const alreadyBlockedSameKind =
      this.isQuotaBlocked() &&
      ExampleShorteningAiService.openAiQuotaKind === (isBillingError ? 'billing' : 'rate_limit');
    if (alreadyBlockedSameKind) return;

    ExampleShorteningAiService.openAiQuotaKind = isBillingError ? 'billing' : 'rate_limit';

    if (isBillingError) {
      // Білінгова помилка не має "минути" — не ставимо фіксований кулдаун
      // на 5 хв, а блокуємо на дуже довгий термін (по суті "назавжди",
      // поки адмін сам не натисне "Продовжити" після поповнення балансу).
      // scheduleAutoResume() свідомо НЕ викликається для цього випадку.
      ExampleShorteningAiService.openAiQuotaBlockedUntil = Date.now() + 24 * 60 * 60 * 1000; // 24 год як заглушка
      this.logger.error(
        `🚫 OpenAI: вичерпано ліміт ОПЛАТИ (insufficient_quota) — це НЕ тимчасовий ліміт швидкості. ` +
        `Автоматичне продовження ВИМКНЕНО для цього випадку: потрібне ручне поповнення балансу на platform.openai.com і ручний клік "Продовжити".`,
      );
    } else {
      ExampleShorteningAiService.openAiQuotaBlockedUntil =
        Date.now() + ExampleShorteningAiService.QUOTA_COOLDOWN_MS;
      this.logger.error(
        `🚫 OpenAI: ліміт швидкості запитів (429). Блокую нові запити на ${ExampleShorteningAiService.QUOTA_COOLDOWN_MS / 1000}с, потім спробую автоматично.`,
      );
    }
  }

  private buildBatchSchema(count: number) {
    return {
      name: 'examples_shortening_batch',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            minItems: count,
            maxItems: count,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                wordId: { type: 'integer' },
                examples: {
                  type: 'array',
                  items: { type: 'string', maxLength: MAX_EXAMPLE_LENGTH },
                  minItems: 6,
                  maxItems: 6,
                },
              },
              required: ['wordId', 'examples'],
            },
          },
        },
        required: ['results'],
      },
    };
  }

  private buildBatchSystemPrompt(): string {
    return `Ти професійний лінгвіст-редактор словникових прикладів речень для
мовного застосунку. Тобі дають список слів/фраз, для кожного з яких уже
є масив "examples" із 6 рядків (English/укр переклад чергуються по
парах: [0]-[1], [2]-[3], [4]-[5]).

Твоя задача для КОЖНОГО слова зі списку — переписати (не просто
обрізати механічно, а переформулювати природною мовою) його "examples"
так, щоб виконувались ОБИДВІ вимоги одночасно:

🔥 1. ЖОРСТКЕ ОБМЕЖЕННЯ ДОВЖИНИ: КОЖЕН з 6 рядків — МАКСИМУМ ${MAX_EXAMPLE_LENGTH} символи,
   включно з пробілами, комами, крапками й будь-якими іншими знаками.
   Порахуй символи перед відповіддю. Якщо треба — спрости/скороти
   речення, головне щоб воно лишалось логічним і граматично коректним
   реченням (а не уривком слів) і зберігало вживання цільового слова.

🕒 2. ЧАСОВА ПРОГРЕСІЯ ПАР РЕЧЕНЬ (обов'язково):
   - Пара [0]-[1]: ТЕПЕРІШНІЙ час (Present Simple/Continuous).
   - Пара [2]-[3]: МИНУЛИЙ час (Past Simple).
   - Пара [4]-[5]: МАЙБУТНІЙ час (Future Simple/"going to").
   Навіть якщо у вхідних даних час переплутано — виправ це в новій версії.

Переклад у парних індексах [1], [3], [5] має бути точним українським
перекладом відповідного англійського речення (того самого індексу мінус 1),
теж не довшим за ${MAX_EXAMPLE_LENGTH} символів.

Якщо приклади для слова вже повністю відповідають ОБОМ вимогам —
поверни їх БЕЗ ЗМІН (той самий текст), не вигадуй заміну заради заміни.

Поверни ЛИШЕ JSON у форматі { "results": [ { "wordId": number, "examples": string[6] }, ... ] } —
рівно по одному об'єкту на кожне слово зі списку, у будь-якому порядку,
з тим самим "wordId", який був у вхідних даних. Жодних пояснень поза JSON.`;
  }

  private async requestBatchShortening(
    batch: Word[],
  ): Promise<{ wordId: number; examples: string[] }[]> {
    this.assertOpenAiAvailable();

    const schema = this.buildBatchSchema(batch.length);
    const systemPrompt = this.buildBatchSystemPrompt();

    const userPayload = batch.map((w) => ({
      wordId: w.id,
      text: w.text,
      examples: Array.isArray(w.examples) ? w.examples : [],
    }));

    const userMessageContent =
      `Ось список слів для редагування прикладів (${batch.length} шт.). ` +
      `Поверни рівно ${batch.length} об'єктів результату, по одному на кожен wordId:\n` +
      JSON.stringify(userPayload);

    let lastError: unknown;

    for (let attempt = 1; attempt <= ExampleShorteningAiService.MAX_BATCH_ATTEMPTS; attempt++) {
      try {
        const response = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessageContent },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: schema,
          } as any,
          temperature: 0,
        });

        const content = response.choices[0].message.content;
        if (!content) {
          this.logger.warn(`Порожня відповідь AI для пачки (спроба ${attempt}/${ExampleShorteningAiService.MAX_BATCH_ATTEMPTS})`);
          continue;
        }

        const parsed = JSON.parse(content) as { results: { wordId: number; examples: string[] }[] };
        if (!Array.isArray(parsed.results) || parsed.results.length === 0) {
          this.logger.warn(`AI повернув порожній/некоректний "results" (спроба ${attempt})`);
          continue;
        }

        return parsed.results;
      } catch (error: any) {
        lastError = error;
        this.markQuotaExhaustedIfNeeded(error);

        if (error?.code === 'insufficient_quota' || error?.status === 429) {
          break;
        }

        this.logger.error(`OpenAI виклик для пачки провалився (спроба ${attempt})`, error);
      }
    }

    // Якщо причина зупинки — саме вичерпана квота, підміняємо сирий
    // OpenAI-виняток на наш маркер: далі по ланцюжку (processBatch →
    // runJobInBackground) це дозволяє одразу зупинити ВЕСЬ job замість
    // того, щоб позначати кожне слово в пачці як окрему "помилку".
    if (this.isQuotaBlocked()) {
      throw new AiQuotaExhaustedError(this.buildQuotaMessage());
    }

    throw lastError instanceof Error ? lastError : new Error('Не вдалося отримати відповідь AI для пачки');
  }

  private async clearWordCaches(wordIds: number[]): Promise<void> {
    await Promise.all([
      // Ключі, якими користується WordService.
      this.cacheService.clear(WordService.ALL_WORDS_CACHE_KEY),
      this.cacheService.clear(WordService.ALL_WORDS_SHORT_CACHE_KEY),
      // Ключі, якими користується WordGenerationService (історично інший
      // префікс — 'v1:words:all'), тому чистимо обидва набори на всяк
      // випадок, щоб адмінка й студентський застосунок не бачили stale-дані.
      this.cacheService.clear('v1:words:all2'),
      this.cacheService.clear('v1:words:all2:short'),
      this.cacheService.clearByPattern('word:*'),
      // Приклади слова змінились глобально — інвалідуємо кеш "мій словник"
      // для ВСІХ користувачів одразу (per-user ключі мають префікс user:<id>:words:*).
      this.cacheService.clearByPattern('user:*:words:*'),
    ]);
    void wordIds; // wordIds лишено в сигнатурі для майбутньої точкової інвалідації (наприклад, по word:<id> кешу), якщо buildWordByIdCacheKey стане публічним.
  }
}