import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { OpenAI } from 'openai';
import { Word } from '../word.entity';
import { WordCategory } from './word-category.entity';
import { ProgramPackage } from 'src/program/entities/program-package.entity';
import { UserWordProgress } from 'src/user-word-progress/user-word-progress.entity';

// ─────────────────────────────────────────────
// Типи чернетки аналізу (те, що бачить і редагує адмін ДО збереження)
// ─────────────────────────────────────────────

export interface CategoryAnalysisJobStats {
  status: 'idle' | 'running' | 'completed' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  totalWordsScanned: number;
  totalPackagesScanned: number;
  processedPackages: number;
  lastError: string | null;
}

export interface CategoryDraftWordItem {
  id: number;
  text: string;
  translation: string;
  type: string;
  partOfSpeech: string | null;
  currentCategory: string | null;
}

export interface CategoryDraftCategoryItem {
  tempId: string;
  name: string;
  description: string;
  wordIds: number[];
  words: CategoryDraftWordItem[];
}

export interface CategoryDraftPackageItem {
  packageId: number;
  packageLevel: string;
  packageName: string | null;
  totalWords: number;
  uncategorizedWordIds: number[];
  uncategorizedWords: CategoryDraftWordItem[];
  categories: CategoryDraftCategoryItem[];
}

export interface CategoryAnalysisResult {
  generatedAt: string;
  totalPackages: number;
  totalWords: number;
  totalCategoriesProposed: number;
  packages: CategoryDraftPackageItem[];
}

interface FixedCategoryDefinition {
  name: string;
  description: string;
}

const emptyJobStats = (): CategoryAnalysisJobStats => ({
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  totalWordsScanned: 0,
  totalPackagesScanned: 0,
  processedPackages: 0,
  lastError: null,
});

// Запасний, фіксований набір із рівно 6 КОНКРЕТНИХ (не абстрактних!)
// тем — використовується ТІЛЬКИ якщо AI-виклик визначення категорій
// провалився (мережа, квота тощо). Кожна тема — побутове, зрозуміле
// поняття, а не розмита абстракція.
const FALLBACK_FIXED_CATEGORIES: FixedCategoryDefinition[] = [
  { name: 'Дім і побут', description: 'Речі, меблі та поняття, пов’язані з домом і повсякденним побутом.' },
  { name: 'Сім’я і люди', description: 'Люди, стосунки, сім’я та соціальні ролі.' },
  { name: 'Природа і тварини', description: 'Тварини, рослини, погода та навколишній світ.' },
  { name: 'Їжа і напої', description: 'Продукти харчування, страви та напої.' },
  { name: 'Дії і рух', description: 'Дієслова дій, руху та фізичної активності.' },
  { name: 'Емоції і характер', description: 'Почуття, емоції та риси характеру людини.' },
];

@Injectable()
export class WordCategoryService {
  private readonly logger = new Logger(WordCategoryService.name);
  private readonly openai: OpenAI;

  // Стан фонової джоби і результат тримаються статично на рівні класу —
  // так само, як зроблено з openAiQuotaBlockedUntil у WordService/
  // WordGenerationService — щоб один запущений аналіз був спільним для
  // всіх запитів адмінки (poll status), а не прив'язаним до конкретного
  // HTTP-запиту.
  private static isRunning = false;
  private static jobStats: CategoryAnalysisJobStats = emptyJobStats();
  private static latestResult: CategoryAnalysisResult | null = null;

  private static readonly WORDS_PER_AI_CALL = 60;

  // Жорсткий ліміт категорій на один пакет. Гарантується СТРУКТУРНО:
  // спершу визначається рівно стільки конкретних тем, а потім кожне
  // слово класифікується через enum у JSON-схемі, що фізично не
  // дозволяє AI повернути назву категорії поза цим списком.
  private static readonly MAX_CATEGORIES_PER_PACKAGE = 6;

  // Скільки слів максимум відправляти в запит визначення тем пакета —
  // не потрібно передавати весь пакет (може бути тисячі слів), досить
  // репрезентативної вибірки, щоб побачити спектр тем.
  private static readonly SAMPLE_SIZE_FOR_THEME_DEFINITION = 200;

  constructor(
    @InjectRepository(Word) private readonly wordRepo: Repository<Word>,
    @InjectRepository(WordCategory) private readonly categoryRepo: Repository<WordCategory>,
    @InjectRepository(ProgramPackage) private readonly programRepo: Repository<ProgramPackage>,
  ) {
    this.openai = new OpenAI({ apiKey: process.env.AI_KEY });
  }

  // ═══════════════════════════════════════════
  // Статус / запуск фонового аналізу
  // ═══════════════════════════════════════════

  getStatus(): { job: CategoryAnalysisJobStats; result: CategoryAnalysisResult | null } {
    return { job: WordCategoryService.jobStats, result: WordCategoryService.latestResult };
  }

  async startAnalysis(): Promise<{ started: boolean; message?: string }> {
    if (WordCategoryService.isRunning) {
      return { started: false, message: 'Аналіз категорій вже виконується. Дочекайтесь завершення.' };
    }

    WordCategoryService.isRunning = true;
    WordCategoryService.jobStats = {
      ...emptyJobStats(),
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    WordCategoryService.latestResult = null;

    // Навмисно НЕ await — це фонова довготривала операція, статус
    // опитується окремим ендпоінтом (як і в AI-розмітці прикладів).
    this.runAnalysisInBackground().catch((err) => {
      this.logger.error('Фонова категоризація слів завершилась непередбаченою помилкою', err);
    });

    return { started: true };
  }

  private async runAnalysisInBackground(): Promise<void> {
    try {
      this.logger.log('🟢 Старт AI-категоризації слів по всіх програмах (packageId IS NOT NULL)');

      const words = await this.wordRepo
        .createQueryBuilder('word')
        .where('word.packageId IS NOT NULL')
        .orderBy('word.id', 'ASC')
        .getMany();

      const byPackage = new Map<number, Word[]>();
      for (const word of words) {
        if (!word.packageId) continue;
        const arr = byPackage.get(word.packageId) ?? [];
        arr.push(word);
        byPackage.set(word.packageId, arr);
      }

      WordCategoryService.jobStats.totalWordsScanned = words.length;
      WordCategoryService.jobStats.totalPackagesScanned = byPackage.size;

      const packageIds = [...byPackage.keys()];
      const packagesMeta = packageIds.length > 0
        ? await this.programRepo.find({ where: { id: In(packageIds) } })
        : [];
      const packageMetaById = new Map(packagesMeta.map((p) => [p.id, p]));

      const resultPackages: CategoryDraftPackageItem[] = [];

      for (const [packageId, packageWords] of byPackage.entries()) {
        try {
          this.logger.log(
            `🔎 Категоризую пакет ${packageId}: ${packageWords.length} слів...`,
          );

          const categories = await this.classifyPackageWords(packageWords);
          const meta = packageMetaById.get(packageId);

          const assignedIds = new Set<number>();
          for (const category of categories) {
            for (const id of category.wordIds) assignedIds.add(id);
          }

          const uncategorizedWords = packageWords.filter((w) => !assignedIds.has(w.id));

          resultPackages.push({
            packageId,
            packageLevel: meta?.level ?? '—',
            packageName: (meta as any)?.name ?? null,
            totalWords: packageWords.length,
            uncategorizedWordIds: uncategorizedWords.map((w) => w.id),
            uncategorizedWords: uncategorizedWords.map((w) => this.toDraftWordItem(w)),
            categories,
          });

          this.logger.log(
            `✅ Пакет ${packageId}: сформовано ${categories.length} категорій ` +
            `(ліміт ${WordCategoryService.MAX_CATEGORIES_PER_PACKAGE}: ${categories.map((c) => c.name).join(', ')}), ` +
            `нерозподілено слів: ${uncategorizedWords.length}`,
          );
        } catch (err) {
          this.logger.error(`❌ Категоризація пакета ${packageId} провалилась`, err as Error);
        } finally {
          WordCategoryService.jobStats.processedPackages += 1;
        }
      }

      const totalCategoriesProposed = resultPackages.reduce(
        (sum, pkg) => sum + pkg.categories.length,
        0,
      );

      WordCategoryService.latestResult = {
        generatedAt: new Date().toISOString(),
        totalPackages: resultPackages.length,
        totalWords: words.length,
        totalCategoriesProposed,
        packages: resultPackages,
      };

      WordCategoryService.jobStats.status = 'completed';
      WordCategoryService.jobStats.finishedAt = new Date().toISOString();

      this.logger.log(
        `🏁 AI-категоризація завершена: ${resultPackages.length} пакетів, ` +
        `${totalCategoriesProposed} категорій сумарно`,
      );
    } catch (error: any) {
      WordCategoryService.jobStats.status = 'failed';
      WordCategoryService.jobStats.finishedAt = new Date().toISOString();
      WordCategoryService.jobStats.lastError = error?.message || 'Невідома помилка';
      this.logger.error('❌ AI-категоризація завершилась з помилкою', error);
    } finally {
      WordCategoryService.isRunning = false;
    }
  }

  private toDraftWordItem(word: Word): CategoryDraftWordItem {
    return {
      id: word.id,
      text: word.text,
      translation: word.translation,
      type: word.type,
      partOfSpeech: word.partOfSpeech ?? null,
      currentCategory: word.category ?? null,
    };
  }

  // ═══════════════════════════════════════════
  // ЕТАП 1: визначення рівно 6 КОНКРЕТНИХ тем для пакета
  // (одноразовий AI-виклик на репрезентативній вибірці слів)
  // ═══════════════════════════════════════════

  private async defineFixedCategories(words: Word[]): Promise<FixedCategoryDefinition[]> {
    const maxCategories = WordCategoryService.MAX_CATEGORIES_PER_PACKAGE;
    const sample = this.buildRepresentativeSample(
      words,
      WordCategoryService.SAMPLE_SIZE_FOR_THEME_DEFINITION,
    );

    const sampleForPrompt = sample.map((w) => ({ text: w.text, translation: w.translation }));

    const schema = {
      name: 'fixed_category_definition',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          categories: {
            type: 'array',
            minItems: maxCategories,
            maxItems: maxCategories,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['name', 'description'],
            },
          },
        },
        required: ['categories'],
      },
    };

    const systemPrompt = `
Ти лінгвіст-методист. Дивлячись на вибірку слів англійської мови з
навчальної програми, визнач РІВНО ${maxCategories} категорії (теми),
на які буде розподілено ВСІ слова цього пакета (не тільки ті, що ти
бачиш у вибірці — тому теми мають бути достатньо широкими, щоб
покрити ввесь спектр лексики цього рівня).

КРИТИЧНО ВАЖЛИВО — назви категорій мають бути КОНКРЕТНИМИ побутовими
темами, а НЕ розмитими абстракціями. 

ПРИКЛАДИ ДОБРИХ (конкретних) назв: "Дім і побут", "Сім’я і люди",
"Природа і тварини", "Їжа і напої", "Одяг і зовнішність", "Подорожі і
транспорт", "Робота і навчання", "Спорт і здоров’я", "Емоції і
характер", "Час і місце", "Тіло і здоров’я", "Гроші і покупки",
"Технології", "Місто і будівлі", "Погода і природні явища".

ПРИКЛАДИ ПОГАНИХ (занадто абстрактних, ЗАБОРОНЕНО використовувати):
"Абстрактні поняття", "Різне", "Інше", "Загальна лексика", "Дії та
стан" (занадто розмито), "Якості" (занадто розмито).

ПРАВИЛА:
1. Обери саме ${maxCategories} тем, які найкраще й найширше описують
   реальний словниковий матеріал з вибірки нижче.
2. Кожна назва — 1-3 слова українською, з великої літери, конкретна
   і зрозуміла (як у прикладах добрих назв вище).
3. Теми не повинні сильно перетинатись за змістом одна з одною.
4. "description" — одне коротке речення українською, що пояснює,
   які саме слова сюди підходять.
5. Одна з тем (в кінці списку) може бути трохи ширшою "парасолькою"
   для дієслів дій/руху чи емоцій, якщо це допоможе покрити слова, які
   не є конкретними предметами — але вона все одно має мати конкретну,
   а не абстрактну назву (наприклад "Дії і рух", а не "Дієслова").

Поверни ЛИШЕ JSON за схемою, без пояснень поза JSON.`;

    const userPrompt = `Вибірка слів пакета (${sample.length} з ${words.length} загалом):\n${JSON.stringify(sampleForPrompt)}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: schema,
        } as any,
        temperature: 0.3,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        this.logger.warn('AI повернув порожню відповідь для визначення тем пакета, використовую fallback-набір');
        return FALLBACK_FIXED_CATEGORIES;
      }

      const parsed = JSON.parse(content) as { categories: FixedCategoryDefinition[] };

      if (!Array.isArray(parsed.categories) || parsed.categories.length === 0) {
        return FALLBACK_FIXED_CATEGORIES;
      }

      // Підстраховка: якщо якимось дивом прийшло не рівно 6 — обрізаємо
      // або доповнюємо fallback-темами до потрібної кількості.
      let categories = parsed.categories
        .map((c) => ({ name: (c.name || '').trim(), description: (c.description || '').trim() }))
        .filter((c) => c.name.length > 0);

      if (categories.length > maxCategories) {
        categories = categories.slice(0, maxCategories);
      } else if (categories.length < maxCategories) {
        const needed = maxCategories - categories.length;
        const usedNames = new Set(categories.map((c) => c.name.toLowerCase()));
        const filler = FALLBACK_FIXED_CATEGORIES.filter((c) => !usedNames.has(c.name.toLowerCase())).slice(0, needed);
        categories = categories.concat(filler);
      }

      return categories;
    } catch (error) {
      this.logger.error('Помилка AI-виклику визначення тем пакета, використовую fallback-набір', error as Error);
      return FALLBACK_FIXED_CATEGORIES;
    }
  }

  private buildRepresentativeSample(words: Word[], sampleSize: number): Word[] {
    if (words.length <= sampleSize) return words;

    const step = words.length / sampleSize;
    const sample: Word[] = [];
    for (let i = 0; i < sampleSize; i++) {
      sample.push(words[Math.floor(i * step)]);
    }
    return sample;
  }

  // ═══════════════════════════════════════════
  // ЕТАП 2: примусовий розподіл усіх слів між 6 фіксованими темами
  // (чанками по WORDS_PER_AI_CALL слів; enum у JSON-схемі гарантує,
  // що AI фізично не може повернути назву поза списком тем)
  // ═══════════════════════════════════════════

  private async classifyPackageWords(words: Word[]): Promise<CategoryDraftCategoryItem[]> {
    const fixedCategories = await this.defineFixedCategories(words);

    const categoryMap = new Map<string, CategoryDraftCategoryItem>();
    const packageId = words[0]?.packageId ?? 0;
    for (const fc of fixedCategories) {
      const key = fc.name.toLowerCase();
      categoryMap.set(key, {
        tempId: `${packageId}:${key}`,
        name: fc.name,
        description: fc.description,
        wordIds: [],
        words: [],
      });
    }

    const chunks: Word[][] = [];
    for (let i = 0; i < words.length; i += WordCategoryService.WORDS_PER_AI_CALL) {
      chunks.push(words.slice(i, i + WordCategoryService.WORDS_PER_AI_CALL));
    }

    const wordById = new Map(words.map((w) => [w.id, w]));
    const firstCategoryKey = fixedCategories[0]?.name.toLowerCase();

    for (const chunk of chunks) {
      const assignments = await this.requestChunkAssignments(chunk, fixedCategories);

      for (const assignment of assignments) {
        const word = wordById.get(assignment.wordId);
        if (!word) continue;

        const key = assignment.categoryName.trim().toLowerCase();
        // Схема з enum структурно гарантує влучання в один із наших
        // ключів, але про всяк випадок (напр. AI трохи змінив регістр
        // чи пробіли) — падаємо назад на першу категорію, а не губимо
        // слово.
        const entry = categoryMap.get(key) ?? (firstCategoryKey ? categoryMap.get(firstCategoryKey) : undefined);
        if (!entry) continue;

        if (!entry.wordIds.includes(word.id)) {
          entry.wordIds.push(word.id);
          entry.words.push(this.toDraftWordItem(word));
        }
      }
    }

    return Array.from(categoryMap.values());
  }

  private async requestChunkAssignments(
    chunk: Word[],
    fixedCategories: FixedCategoryDefinition[],
  ): Promise<Array<{ wordId: number; categoryName: string }>> {
    const wordListForPrompt = chunk.map((w) => ({
      id: w.id,
      text: w.text,
      translation: w.translation,
      partOfSpeech: w.partOfSpeech,
      type: w.type,
    }));

    const categoryNames = fixedCategories.map((c) => c.name);

    const schema = {
      name: 'fixed_word_category_assignment',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          assignments: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                wordId: { type: 'number' },
                category: { type: 'string', enum: categoryNames },
              },
              required: ['wordId', 'category'],
            },
          },
        },
        required: ['assignments'],
      },
    };

    const categoriesBlock = fixedCategories
      .map((c) => `- "${c.name}": ${c.description}`)
      .join('\n');

    const systemPrompt = `
Ти лінгвіст-методист. Для цього навчального пакета ВЖЕ ОСТАТОЧНО
визначено рівно ${fixedCategories.length} категорій — список нижче
ЗАКРИТИЙ. Створювати нові категорії заборонено, і схема відповіді
структурно дозволяє тільки ці назви:

${categoriesBlock}

Твоє завдання — для КОЖНОГО слова обрати РІВНО ОДНУ категорію зі
списку вище, яка підходить НАЙЛОГІЧНІШЕ за змістом слова.

ВАЖЛИВО: якщо слово не підходить ідеально до жодної категорії — все
одно ОБОВ'ЯЗКОВО обери найближчу за змістом (навіть якщо приблизно),
спираючись на основне/буквальне значення слова, і на асоціації, які
воно викликає. Пропусків бути не може — кожне слово повинно отримати
категорію.

Тип слова (word / phrase / phrasal_verb) не впливає на вибір —
розподіляй фрази й фразові дієслова так само, як звичайні слова,
за їхнім змістом.

Поверни ЛИШЕ JSON за схемою, без пояснень поза JSON.`;

    const userPrompt = `Розподіли ці слова за наведеними категоріями:\n${JSON.stringify(wordListForPrompt)}`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: schema,
        } as any,
        temperature: 0.2,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        this.logger.warn('AI повернув порожню відповідь для чанку категоризації');
        return [];
      }

      const parsed = JSON.parse(content) as {
        assignments: Array<{ wordId: number; category: string }>;
      };

      if (!Array.isArray(parsed.assignments)) return [];

      return parsed.assignments.map((a) => ({
        wordId: a.wordId,
        categoryName: a.category,
      }));
    } catch (error) {
      this.logger.error('Помилка запиту категоризації до AI', error as Error);
      return [];
    }
  }

  // ═══════════════════════════════════════════
  // Збереження (з можливістю ручного редагування адміном перед
  // збереженням — фронтенд надсилає той самий формат CategoryDraftPackageItem[],
  // можливо вже змінений: перейменовані категорії, перекинуті слова,
  // видалені категорії, додані нові вручну)
  // ═══════════════════════════════════════════

  async saveCategories(
    packages: CategoryDraftPackageItem[],
  ): Promise<{ success: boolean; updatedWords: number; savedCategories: number; clearedWords: number }> {
    let updatedWords = 0;
    let savedCategories = 0;
    let clearedWords = 0;

    for (const pkg of packages) {
      // Спочатку знімаємо категорію з тих слів, які адмін явно лишив
      // "без категорії" (uncategorizedWordIds) — це важливо для випадку
      // переприсвоєння: слово могло мати стару категорію в БД, а в
      // новій чернетці опинилось у "нерозподілених".
      if (pkg.uncategorizedWordIds && pkg.uncategorizedWordIds.length > 0) {
        const clearResult = await this.wordRepo.update(
          { id: In(pkg.uncategorizedWordIds) },
          { category: null },
        );
        clearedWords += clearResult.affected || 0;
      }

      for (const category of pkg.categories) {
        const cleanName = (category.name || '').trim();
        if (!cleanName || !category.wordIds || category.wordIds.length === 0) continue;

        let categoryRow = await this.categoryRepo.findOne({
          where: { packageId: pkg.packageId, name: cleanName },
        });

        if (!categoryRow) {
          categoryRow = this.categoryRepo.create({
            packageId: pkg.packageId,
            name: cleanName,
            description: category.description || null,
          });
          await this.categoryRepo.save(categoryRow);
        } else if (category.description && category.description !== categoryRow.description) {
          categoryRow.description = category.description;
          await this.categoryRepo.save(categoryRow);
        }

        savedCategories += 1;

        const updateResult = await this.wordRepo.update(
          { id: In(category.wordIds) },
          { category: cleanName },
        );
        updatedWords += updateResult.affected || 0;
      }
    }

    this.logger.log(
      `💾 Збереження категорій: оновлено слів=${updatedWords}, ` +
      `знято категорію з=${clearedWords}, збережено/оновлено категорій=${savedCategories}`,
    );

    return { success: true, updatedWords, savedCategories, clearedWords };
  }

  async listCategories(packageId?: number): Promise<WordCategory[]> {
    if (packageId) {
      return this.categoryRepo.find({ where: { packageId }, order: { name: 'ASC' } });
    }
    return this.categoryRepo.find({ order: { packageId: 'ASC', name: 'ASC' } });
  }

  // ═══════════════════════════════════════════
  // Керування ВЖЕ ЗБЕРЕЖЕНИМИ категоріями (окремо від чернетки аналізу
  // вище) — перегляд слів+категорій конкретного пакета, ручне створення
  // категорії, переміщення слів між категоріями. Використовується
  // окремою вкладкою "Наявні категорії" на фронтенді.
  // ═══════════════════════════════════════════

  /**
   * Повертає одним запитом усі збережені категорії пакета + всі слова
   * цього пакета (зі своїм поточним category, або null, якщо слово ще
   * не розподілене). Фронтенд сам групує слова по категоріях локально
   * (за співпадінням word.category === category.name), щоб не робити
   * окремий запит на кожну категорію.
   */
  async getCategoryManagementData(packageId: number): Promise<{
    packageId: number;
    categories: WordCategory[];
    words: CategoryDraftWordItem[];
  }> {
    const [categories, words] = await Promise.all([
      this.categoryRepo.find({ where: { packageId }, order: { name: 'ASC' } }),
      this.wordRepo.find({
        where: { packageId },
        order: { text: 'ASC' },
      }),
    ]);

    return {
      packageId,
      categories,
      words: words.map((w) => this.toDraftWordItem(w)),
    };
  }

  /**
   * Ручне створення порожньої категорії (без AI) — адмін одразу потім
   * перекидає в неї слова через moveWordsToCategory. Якщо категорія з
   * такою назвою в пакеті вже існує — просто повертає її (не кидає
   * помилку унікальності), щоб форма створення була "дурнестійкою".
   */
  async createCategory(
    packageId: number,
    name: string,
    description: string | null,
  ): Promise<WordCategory> {
    const cleanName = name.trim();
    const existing = await this.categoryRepo.findOne({ where: { packageId, name: cleanName } });
    if (existing) return existing;

    const row = this.categoryRepo.create({
      packageId,
      name: cleanName,
      description: description?.trim() || null,
    });
    return this.categoryRepo.save(row);
  }

  /**
   * Переміщує список слів у вказану категорію (за назвою) або знімає
   * категорію взагалі, якщо category === null. Працює як для одного
   * слова (переміщення через dropdown), так і для масового вибору
   * (bulk-переміщення позначених слів).
   */
  async moveWordsToCategory(
    wordIds: number[],
    category: string | null,
  ): Promise<{ updatedWords: number }> {
    if (!wordIds || wordIds.length === 0) return { updatedWords: 0 };

    const updateResult = await this.wordRepo.update({ id: In(wordIds) }, { category });
    return { updatedWords: updateResult.affected || 0 };
  }

  async deleteCategory(id: number): Promise<{ success: boolean; unassignedWords: number }> {
    const category = await this.categoryRepo.findOne({ where: { id } });
    if (!category) {
      return { success: false, unassignedWords: 0 };
    }

    const updateResult = await this.wordRepo.update(
      { packageId: category.packageId, category: category.name },
      { category: null },
    );

    await this.categoryRepo.delete(id);

    return { success: true, unassignedWords: updateResult.affected || 0 };
  }

  async getGlobalCategoryStatsForUser(
  userId: number,
): Promise<Array<{ name: string; description: string | null; total: number; learned: number }>> {
  const rawStats = await this.wordRepo
    .createQueryBuilder('word')
    .leftJoin(
      UserWordProgress,
      'progress',
      'progress.wordId = word.id AND progress.userId = :userId',
      { userId },
    )
    .where('word.category IS NOT NULL')
    .select('word.category', 'category')
    .addSelect('COUNT(DISTINCT word.id)', 'totalCount')
    .addSelect(
      "COUNT(DISTINCT CASE WHEN progress.status = 'learned' THEN word.id END)",
      'learnedCount',
    )
    .groupBy('word.category')
    .orderBy('word.category', 'ASC')
    .getRawMany<{ category: string; totalCount: string; learnedCount: string }>();
 
  if (rawStats.length === 0) return [];
 
  // Опис категорії беремо з уже збережених рядків WordCategory — перший
  // знайдений збіг за назвою (описи для однієї назви в різних пакетах
  // зазвичай ідентичні чи майже ідентичні, бо генеруються за тим самим
  // фіксованим набором тем).
  const categoryRows = await this.categoryRepo.find();
  const descriptionByName = new Map<string, string | null>();
  for (const row of categoryRows) {
    if (!descriptionByName.has(row.name)) {
      descriptionByName.set(row.name, row.description ?? null);
    }
  }
 
  return rawStats.map((row) => ({
    name: row.category,
    description: descriptionByName.get(row.category) ?? null,
    total: parseInt(row.totalCount, 10) || 0,
    learned: parseInt(row.learnedCount, 10) || 0,
  }));
}


  async renameCategory(
    id: number,
    newName: string,
  ): Promise<{ success: boolean; updatedWords: number }> {
    const category = await this.categoryRepo.findOne({ where: { id } });
    if (!category) return { success: false, updatedWords: 0 };

    const cleanName = newName.trim();
    if (!cleanName) return { success: false, updatedWords: 0 };

    const updateResult = await this.wordRepo.update(
      { packageId: category.packageId, category: category.name },
      { category: cleanName },
    );

    category.name = cleanName;
    await this.categoryRepo.save(category);

    return { success: true, updatedWords: updateResult.affected || 0 };
  }

  // ═══════════════════════════════════════════
  // Статистика по категоріях для конкретного юзера/пакета — той самий
  // принцип, що й ProgramService.getProgramStats (тип), тільки групуємо
  // по category замість type.
  // ═══════════════════════════════════════════

  async getCategoryStatsForPackage(
    userId: number,
    packageId: number,
  ): Promise<Array<{ category: string; total: number; learned: number }>> {
    const rawStats = await this.wordRepo
      .createQueryBuilder('word')
      .leftJoin(
        UserWordProgress,
        'progress',
        'progress.wordId = word.id AND progress.userId = :userId',
        { userId },
      )
      .where('word.packageId = :packageId', { packageId })
      .andWhere('word.category IS NOT NULL')
      .select('word.category', 'category')
      .addSelect('COUNT(word.id)', 'totalCount')
      .addSelect("COUNT(CASE WHEN progress.status = 'learned' THEN 1 END)", 'learnedCount')
      .groupBy('word.category')
      .orderBy('word.category', 'ASC')
      .getRawMany<{ category: string; totalCount: string; learnedCount: string }>();

    return rawStats.map((row) => ({
      category: row.category,
      total: parseInt(row.totalCount, 10) || 0,
      learned: parseInt(row.learnedCount, 10) || 0,
    }));
  }
}