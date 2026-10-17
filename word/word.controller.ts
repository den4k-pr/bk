import { parseLevelsFilter } from './level-filter.util';
import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  Get,
  Param,
  ParseIntPipe,
  NotFoundException,
  Delete,
  BadRequestException,
  Query,
  HttpCode,
  Logger,
  Patch,
  Header,
  ParseArrayPipe,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WordService, ProgressBatchResult, DictionaryFilters } from './word.service';
import { Word } from './word.entity';
import { WordCategoryService, CategoryDraftPackageItem } from './category/word-category.service';
import { Request } from 'express';
import { StudyStatus, UserWord, DictionarySourceType } from './user-word.entity';
import {
  CreateWordDto,
  ResetProgressByLevelDto,
  UpdateUserWordDto,
  UpdateUserWordProgressBatchDto,
} from './word-dto';
import { DeleteWordsDto, ResetProgressDto } from './delete-words.dto';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UserWordProgressService } from 'src/user-word-progress/UserWordProgressService';
import { CacheService } from 'src/cache/cache.service';
import { Throttle } from '@nestjs/throttler';

// 🔒 Нове слово/фраза може запустити кілька викликів gpt-4o (виправлення
// одруку, лема, генерація прикладів). Довжина запиту обмежена, щоб
// випадковий або навмисний "текст на сторінку" не перетворювався на
// дорогий AI-запит і глобальне "слово" для всіх.
const MAX_WORD_QUERY_LENGTH = 150;

function assertWordQueryLength(value: string) {
  if (value.length > MAX_WORD_QUERY_LENGTH) {
    throw new BadRequestException(`Запит задовгий (максимум ${MAX_WORD_QUERY_LENGTH} символів)`);
  }
}

interface JwtRequest extends Request {
  user: {
    id: number;
    email?: string;
    role?: string;
  };
}

export class UpdateWordsStatusDto {
  @IsArray()
  @IsNotEmpty()
  @IsNumber({}, { each: true })
  @Type(() => Number)
  wordIds!: number[];
}

function assertAdmin(req: JwtRequest): void {
  const adminSecret = process.env.ADMIN_SECRET;
  const providedSecret = (req.headers['x-admin-secret'] as string) ?? '';

  const hasValidSecret =
    adminSecret && adminSecret.length > 0 && providedSecret === adminSecret;
  const hasAdminRole = req.user?.role === 'admin';

  if (!hasValidSecret && !hasAdminRole) {
    throw new ForbiddenException('Admin access required');
  }
}

// Запис створено саме цим запитом (а не повернуто наявний)? addedAt ставить
// БД, тож допускаємо невеликий розбіг годинників сервера й БД.
const CREATED_CLOCK_SLACK_MS = 5000;
function isCreatedDuringRequest(addedAt: Date | string | null | undefined, requestStartedAt: number): boolean {
  if (!addedAt) return true;
  const time = new Date(addedAt).getTime();
  return Number.isNaN(time) ? true : time >= requestStartedAt - CREATED_CLOCK_SLACK_MS;
}

@ApiTags('words')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('words')
export class WordController {
  private readonly logger = new Logger(WordController.name);

  constructor(
    private readonly wordService: WordService,
    private readonly userWordProgressService: UserWordProgressService,
    private readonly cacheService: CacheService,
    private readonly wordCategoryService: WordCategoryService,
  ) {}

  @Post('admin/create-many')
  @ApiOperation({ summary: 'Admin: bulk create words' })
  async createManyWords(@Req() req: JwtRequest, @Body() words: CreateWordDto[]) {
    assertAdmin(req);

    if (!words || !Array.isArray(words) || words.length === 0) {
      throw new BadRequestException('Масив слів не може бути порожнім');
    }
    return this.wordService.createWordManually(words);
  }

@Post('search-or-create')
// 60/хв: більшість тапів у читалці — це пошук у БД, а не генерація AI;
// 20/хв легко вичерпувались під час читання складного тексту.
@Throttle({ default: { limit: 60, ttl: 60000 } })
@ApiOperation({ summary: 'Smart Search: Find by text/translation or create via AI if missing' })
async searchOrCreateGlobalWord(
  @Req() req: any,
  @Body('query') query: string,
  @Body('partOfSpeech') partOfSpeech?: string,
  @Body('context') context?: string,
) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new BadRequestException('Запит не може бути порожнім');
  }
  assertWordQueryLength(query.trim());

  const userId = req.user.id;

  return this.wordService.searchOrCreateGlobalWord(
    userId,
    query.trim(),
    partOfSpeech,
    typeof context === 'string' ? context : undefined,
  );
}

  @Post('lookup-report')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @HttpCode(201)
  @ApiOperation({ summary: 'Reader: report a wrong word / translation for a tapped word' })
  async reportLookup(
    @Req() req: JwtRequest,
    @Body('surface') surface: string,
    @Body('context') context?: string,
    @Body('wordId') wordId?: number,
    @Body('bookId') bookId?: number,
  ) {
    if (typeof surface !== 'string' || !surface.trim()) {
      throw new BadRequestException('Слово не може бути порожнім');
    }
    assertWordQueryLength(surface.trim());
    return this.wordService.createLookupReport(req.user.id, {
      surface: surface.trim(),
      context: typeof context === 'string' ? context : undefined,
      wordId: Number.isFinite(Number(wordId)) ? Number(wordId) : undefined,
      bookId: Number.isFinite(Number(bookId)) ? Number(bookId) : undefined,
    });
  }

  @Post('admin/update')
  @ApiOperation({ summary: 'Admin: update word fields' })
  async updateWords(@Req() req: JwtRequest, @Body() body: CreateWordDto | CreateWordDto[]) {
    assertAdmin(req);
    const words = Array.isArray(body) ? body : [body];
    return this.wordService.updateWords(words);
  }

  @Delete('admin/remove-word/:id')
  @ApiOperation({ summary: 'Admin: delete a word globally' })
  async deleteWord(
    @Req() req: JwtRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    assertAdmin(req);
    return this.wordService.deleteWord(id);
  }

  @Delete('admin/nuke-all-data')
  @HttpCode(200)
  @ApiOperation({ summary: 'Admin: wipe all words and cache — IRREVERSIBLE' })
  async nukeAllWordData(@Req() req: JwtRequest) {
    assertAdmin(req);

    this.logger.warn(
      `☢️ ADMIN WIPE initiated by user ${req.user.id} (${req.user.email ?? 'unknown'})`,
    );

    return this.wordService.clearAllData();
  }

  @Post('admin/categories/analyze/start')
  @ApiOperation({ summary: 'Admin: start AI category analysis for all program words (draft, not saved)' })
  async startCategoryAnalysis(@Req() req: JwtRequest) {
    assertAdmin(req);
    return this.wordCategoryService.startAnalysis();
  }

  @Get('admin/categories/analyze/status')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  @ApiOperation({ summary: 'Admin: poll AI category analysis status + draft result' })
  async getCategoryAnalysisStatus(@Req() req: JwtRequest) {
    assertAdmin(req);
    return this.wordCategoryService.getStatus();
  }

  @Post('admin/categories/save')
  @ApiOperation({ summary: 'Admin: persist (possibly manually edited) category draft into DB' })
  async saveCategoryAnalysis(@Req() req: JwtRequest, @Body() body: any) {
    assertAdmin(req);

    const rawPackages = Array.isArray(body) ? body : body?.packages;

    if (!rawPackages || !Array.isArray(rawPackages) || rawPackages.length === 0) {
      throw new BadRequestException(
        'Некоректний формат даних для збереження категорій (очікується { packages: [...] } або просто масив пакетів)',
      );
    }

    const normalizedPackages: CategoryDraftPackageItem[] = rawPackages.map((pkg: any) => ({
      packageId: Number(pkg?.packageId),
      packageLevel: pkg?.packageLevel ?? '—',
      packageName: pkg?.packageName ?? null,
      totalWords: Number(pkg?.totalWords) || 0,
      uncategorizedWordIds: Array.isArray(pkg?.uncategorizedWordIds)
        ? pkg.uncategorizedWordIds.map((id: any) => Number(id)).filter((id: number) => !isNaN(id))
        : [],
      uncategorizedWords: Array.isArray(pkg?.uncategorizedWords) ? pkg.uncategorizedWords : [],
      categories: Array.isArray(pkg?.categories)
        ? pkg.categories.map((cat: any) => ({
            tempId: cat?.tempId ?? '',
            name: (cat?.name ?? '').toString(),
            description: cat?.description ?? '',
            wordIds: Array.isArray(cat?.wordIds)
              ? cat.wordIds.map((id: any) => Number(id)).filter((id: number) => !isNaN(id))
              : [],
            words: Array.isArray(cat?.words) ? cat.words : [],
          }))
        : [],
    }));

    this.logger.log(
      `💾 Збереження категорій: отримано ${normalizedPackages.length} пакет(ів), ` +
      `${normalizedPackages.reduce((sum, p) => sum + p.categories.length, 0)} категорій сумарно`,
    );

    const result = await this.wordCategoryService.saveCategories(normalizedPackages);

    await Promise.all([
      this.cacheService.clear('words:all2'),
      this.cacheService.clear('words:all2-short'),
    ]);

    return result;
  }

  @Get('admin/categories')
  @ApiOperation({ summary: 'Admin: list saved word categories, optionally filtered by packageId' })
  @ApiQuery({ name: 'packageId', required: false })
  async listCategories(@Req() req: JwtRequest, @Query('packageId') packageId?: string) {
    assertAdmin(req);
    const parsedPackageId = packageId ? parseInt(packageId, 10) : undefined;
    return this.wordCategoryService.listCategories(
      parsedPackageId && !isNaN(parsedPackageId) ? parsedPackageId : undefined,
    );
  }

  @Patch('admin/categories/:id')
  @ApiOperation({ summary: 'Admin: rename an existing saved category (updates all its words too)' })
  async renameCategory(
    @Req() req: JwtRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body('name') name: string,
  ) {
    assertAdmin(req);
    if (!name || !name.trim()) {
      throw new BadRequestException('Назва категорії не може бути порожньою');
    }
    return this.wordCategoryService.renameCategory(id, name);
  }

  @Delete('admin/categories/:id')
  @ApiOperation({ summary: 'Admin: delete a saved category (words become uncategorized, not deleted)' })
  async deleteCategory(@Req() req: JwtRequest, @Param('id', ParseIntPipe) id: number) {
    assertAdmin(req);
    return this.wordCategoryService.deleteCategory(id);
  }

  // 🔒 Уся глобальна база слів одним запитом — лише адмін. Раніше ці
  // маршрути віддавали всю базу (з прикладами й описами) будь-якому
  // користувачу з акаунтом; застосунок і адмінка їх не викликають.
  @Get('all/pronunciations')
  @ApiOperation({ summary: 'Admin: get all word ids + pronunciations' })
  async getAllWordsPronunciations(@Req() req: JwtRequest) {
    assertAdmin(req);
    return this.wordService.getAllWordsPronunciations();
  }

  @Get('all/short')
  @ApiOperation({ summary: 'Admin: get all words — short form (id, text, pronunciation, translation)' })
  async getAllWordsShort(@Req() req: JwtRequest) {
    assertAdmin(req);
    return this.wordService.getAllWordsShort();
  }

  @Get('all')
  @ApiOperation({ summary: 'Admin: get all words — full form' })
  async getAllWords(@Req() req: JwtRequest) {
    assertAdmin(req);
    return this.wordService.getAllWords();
  }

  @Get('search')
  @ApiOperation({ summary: 'Search global words with user-added status' })
  @ApiQuery({ name: 'query', required: true })
  async searchWords(@Req() req: JwtRequest, @Query('query') query: string) {
    if (!query || !query.trim()) {
      throw new BadRequestException('Query parameter cannot be empty');
    }
    return this.wordService.searchWordsWithUserStatus(
      req.user.id,
      query.trim().toLowerCase(),
    );
  }

  @Get('find-exact')
  @ApiOperation({ summary: 'Find exact word match with user-added status' })
  @ApiQuery({ name: 'term', required: true })
  async findExactWord(@Req() req: JwtRequest, @Query('term') term: string) {
    if (!term || !term.trim()) {
      throw new BadRequestException('Search term cannot be empty');
    }
    return this.wordService.findExactWordWithUserStatus(
      req.user.id,
      term.trim().toLowerCase(),
    );
  }

  @Get('categories/stats')
  @ApiOperation({ summary: 'Get category (thematic set) list with total/learned stats for current user' })
  async getCategoriesStats(@Req() req: JwtRequest) {
    return this.wordCategoryService.getGlobalCategoryStatsForUser(req.user.id);
  }

  @Post('add')
@Throttle({ default: { limit: 20, ttl: 60000 } })
@ApiOperation({ summary: 'Add a word to user dictionary (uses WordGenerationService pipeline)' })
async addWord(
  @Req() req: JwtRequest,
  @Body('text') text: string,
  @Body('userTranslation') userTranslation?: string,
  @Body('userText') userText?: string,
  @Body('partOfSpeech') partOfSpeech?: string,
  @Body('sourceType') sourceType?: DictionarySourceType,
  @Body('sourceBookId') sourceBookId?: number,
  @Body('sourceBookTitle') sourceBookTitle?: string,
) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new BadRequestException('Текст слова не може бути порожнім');
  }
  assertWordQueryLength(text.trim());

  const requestStartedAt = Date.now();
  const userWord = await this.wordService.addOrGetUserWord(
    req.user.id,
    text,
    userTranslation,
    userText,
    partOfSpeech,
    sourceType ? { type: sourceType, bookId: sourceBookId, bookTitle: sourceBookTitle } : undefined,
  );

  if (!userWord) {
    throw new BadRequestException('Не вдалося створити або знайти слово');
  }

  // Переклад знайдено, але запис не пройшов перевірку якості й не
  // збережений: показуємо переклад, нічого не додаючи в словник.
  if ((userWord as { transient?: boolean }).transient) {
    return {
      message: 'Переклад знайдено, але слово не додано до словника',
      word: userWord.word,
      isAdded: false,
      userWordId: null,
      transient: true,
    };
  }

  return {
    message: 'Слово успішно додано',
    word: userWord.word,
    isAdded: true,
    userWordId: userWord.id,
    correction: userWord.correction ?? null,
    wasCreated: isCreatedDuringRequest(userWord.addedAt, requestStartedAt),
  };
}

@Post('simple-add')
  @ApiOperation({ summary: 'Add word from global dictionary (no AI)' })
  async addSimpleWord(
    @Req() req: JwtRequest,
    @Body('text') text: string,
    @Body('sourceType') sourceType?: DictionarySourceType,
    @Body('sourceBookId') sourceBookId?: number,
    @Body('sourceBookTitle') sourceBookTitle?: string,
    // id конкретного значення (омоніми: "train" — іменник / дієслово).
    @Body('wordId') wordId?: number,
    @Body('sourceSentence') sourceSentence?: string,
    @Body('sourceSurface') sourceSurface?: string,
  ) {
    if (!text || !text.trim()) {
      throw new BadRequestException('Текст слова не може бути порожнім');
    }

    const requestStartedAt = Date.now();
    const addedWord = await this.wordService.addSimpleWordToUserList(
      req.user.id,
      text,
      sourceType
        ? {
            type: sourceType,
            bookId: sourceBookId,
            bookTitle: sourceBookTitle,
            sentence: typeof sourceSentence === 'string' ? sourceSentence : undefined,
            surface: typeof sourceSurface === 'string' ? sourceSurface : undefined,
          }
        : undefined,
      typeof wordId === 'number' ? wordId : Number.isFinite(Number(wordId)) ? Number(wordId) : undefined,
    );

    if (!addedWord) throw new NotFoundException('Слово не додано');

    const word = addedWord.word as Word & { userTranslation?: string | null; userText?: string | null };
    // Те саме, що віддає список словника (getUserWordsPaginated): підсвітка
    // прикладів і користувацькі поля на самому слові.
    try {
      await this.wordService.ensureExampleHighlights(word);
    } catch {
      // Підсвітка не обов'язкова для додавання.
    }
    word.userTranslation = addedWord.userTranslation || null;
    word.userText = addedWord.userText || null;

    return {
      message: 'Слово успішно додано',
      word,
      isAdded: true,
      userWordId: addedWord.id,
      // false — слово вже було в словнику (повернули наявний запис):
      // клієнт не збільшує лічильники Словника.
      wasCreated: isCreatedDuringRequest(addedWord.addedAt, requestStartedAt),
      // Відповідь має форму запису словника (UserWord): клієнт кладе її
      // прямо в список Словника. Без id запис у списку був "мертвим" —
      // не відкривався, доки список не перезавантажиться з сервера.
      // user навмисно не віддаємо.
      id: addedWord.id,
      isInDictionary: true,
      status: addedWord.status,
      notes: addedWord.notes,
      isFavorite: addedWord.isFavorite,
      userText: addedWord.userText,
      userTranslation: addedWord.userTranslation,
      sourceType: addedWord.sourceType,
      sourceBookId: addedWord.sourceBookId,
      sourceBookTitle: addedWord.sourceBookTitle,
      sourceSentence: addedWord.sourceSentence,
      sourceSurface: addedWord.sourceSurface,
      srsLevel: addedWord.srsLevel,
      nextReviewAt: addedWord.nextReviewAt,
      addedAt: addedWord.addedAt,
    };
  }

  @Post('bulk-add')
  @ApiOperation({ summary: 'Add multiple words from global dictionary at once' })
  async addManyUserWords(
    @Req() req: JwtRequest,
    @Body('words') words: string[],
  ) {
    if (!words || !Array.isArray(words) || words.length === 0) {
      throw new BadRequestException('Масив слів не може бути порожнім');
    }
    return this.wordService.addManyWordsToUser(req.user.id, words);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get all user words — full form' })
  async getUserWords(@Req() req: JwtRequest) {
    return this.wordService.getUserWords(req.user.id);
  }

  @Get('me/short')
  @ApiOperation({ summary: 'Get user words — short form' })
  async getUserWordsShort(@Req() req: JwtRequest) {
    return this.wordService.getUserWordsShort(req.user.id);
  }

@Get('me/paginated')
@ApiOperation({ summary: 'Get user words — paginated with filters' })
@ApiQuery({ name: 'page', required: false })
@ApiQuery({ name: 'pageSize', required: false })
@ApiQuery({ name: 'level', required: false })
@ApiQuery({ name: 'status', required: false, description: 'new, learning, learned, all, favorite' })
@ApiQuery({ name: 'searchQuery', required: false })
@ApiQuery({ name: 'type', required: false, description: 'word, phrase, or phrasal_verb' })
async getUserWordsPaginated(
  @Req() req: JwtRequest,
  @Query('page') pageStr?: string,
  @Query('pageSize') pageSizeStr?: string,
  @Query('level') level?: string,
  @Query('status') status?: string,
  @Query('searchQuery') searchQuery?: string,
  @Query('type') type?: string,
) {
  const page = pageStr ? parseInt(pageStr, 10) : 1;
  if (isNaN(page) || page < 1) {
    throw new BadRequestException('page must be a positive integer');
  }

  const pageSize = pageSizeStr ? parseInt(pageSizeStr, 10) : 10;
  if (isNaN(pageSize) || pageSize < 1) {
    throw new BadRequestException('pageSize must be a positive integer');
  }

  if (
    status &&
    !Object.values(StudyStatus).includes(status as StudyStatus) &&
    status !== 'favorite' &&
    status !== 'all'
  ) {
    throw new BadRequestException('Invalid study status');
  }

  if (type && !['word', 'phrase', 'phrasal_verb', 'all'].includes(type)) {
    throw new BadRequestException('Invalid word type');
  }

  return this.wordService.getUserWordsPaginated(
    req.user.id,
    page,
    pageSize,
    level,
    status,
    searchQuery,
    type,
  );
}

  @Get('me/search')
  @ApiOperation({ summary: 'Search within user words' })
  @ApiQuery({ name: 'query', required: true })
  @ApiQuery({ name: 'level', required: false })
  @ApiQuery({ name: 'status', required: false, enum: StudyStatus })
  async searchUserWords(
    @Req() req: JwtRequest,
    @Query('query') query: string,
    @Query('level') level?: string,
    @Query('status') status?: StudyStatus,
  ) {
    if (!query || !query.trim()) {
      throw new BadRequestException('Query parameter cannot be empty');
    }

    if (status && !Object.values(StudyStatus).includes(status)) {
      throw new BadRequestException('Invalid study status');
    }

    return this.wordService.searchUserWords(
      req.user.id,
      query.trim().toLowerCase(),
      level,
      status,
    );
  }

  @Get('me/random')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  @ApiOperation({ summary: 'Get 3 random non-learned words for study session (optionally filtered by category)' })
  @ApiQuery({
    name: 'category',
    required: false,
    description:
      'Назва тематичної категорії (як у Word.category). Якщо передано — вибірка йде ТІЛЬКИ зі слів цієї категорії, а total/learned у відповіді рахуються в межах категорії. Якщо не передано — поведінка як і раніше (змішаний потік по всіх доступних програмах).',
  })
  async getUserRandomWords(
    @Req() req: JwtRequest,
    @Query('category') category?: string,
  ) {
    return this.wordService.getUserRandomWordsForStudy(req.user.id, category);
  }

  @Get('me/dictionary/random')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  @ApiOperation({ summary: 'Get N words from user dictionary prioritized by SRS due date, optionally filtered by source' })
  @ApiQuery({ name: 'count', required: false, description: 'Скільки слів повернути (1-5, за замовчуванням 1)' })
  @ApiQuery({ name: 'bookIds', required: false, description: 'Comma-separated список id книг' })
  @ApiQuery({ name: 'packages', required: false, description: 'true — включити слова з пакетів (карток)' })
  @ApiQuery({ name: 'manual', required: false, description: 'true — включити слова, додані вручну' })
  @ApiQuery({ name: 'favoritesOnly', required: false, description: 'true — включити слова, позначені улюбленими' })
  @ApiQuery({ name: 'levels', required: false, description: 'Comma-separated рівні слів (A1,B2); без параметра — усі' })
  async getUserRandomDictionaryWords(
    @Req() req: JwtRequest,
    @Query('count') countStr?: string,
    @Query('bookIds') bookIdsStr?: string,
    @Query('packages') packagesStr?: string,
    @Query('manual') manualStr?: string,
    @Query('favoritesOnly') favoritesOnlyStr?: string,
    @Query('levels') levelsStr?: string,
  ) {
    const parsedCount = countStr ? parseInt(countStr, 10) : 1;
    const count = isNaN(parsedCount) ? 1 : Math.min(Math.max(parsedCount, 1), 5);

    const filters: DictionaryFilters = {
      bookIds: bookIdsStr
        ? bookIdsStr.split(',').map((id) => parseInt(id, 10)).filter((id) => !isNaN(id))
        : [],
      packages: packagesStr === 'true',
      manual: manualStr === 'true',
      favoritesOnly: favoritesOnlyStr === 'true',
      levels: parseLevelsFilter(levelsStr),
    };

    return this.wordService.getUserRandomDictionaryWordsForStudy(req.user.id, count, filters);
  }

  @Get('dictionary/capacity')
  @ApiOperation({ summary: 'Dictionary capacity: free limit, count, unlimited (purchase / premium)' })
  async getDictionaryCapacity(@Req() req: JwtRequest) {
    return this.wordService.getDictionaryCapacity(req.user.id);
  }

  @Get('dictionary/filters/options')
  @ApiOperation({ summary: 'Get available dictionary source filters (books, packages, manual, favorites) with word counts' })
  async getDictionaryFilterOptions(@Req() req: JwtRequest) {
    return this.wordService.getDictionaryFilterOptions(req.user.id);
  }

  @Post('dictionary/filters/count')
  @ApiOperation({ summary: 'Get exact word count for a given source filter selection' })
  async getDictionaryFilteredCount(
    @Req() req: JwtRequest,
    @Body('bookIds') bookIdsRaw?: string[],
    @Body('packages') packages?: boolean,
    @Body('manual') manual?: boolean,
    @Body('favoritesOnly') favoritesOnly?: boolean,
    @Body('levels') levelsRaw?: string[] | string,
  ) {
    const filters: DictionaryFilters = {
      bookIds: Array.isArray(bookIdsRaw) ? bookIdsRaw.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id)) : [],
      packages: !!packages,
      manual: !!manual,
      favoritesOnly: !!favoritesOnly,
      levels: parseLevelsFilter(levelsRaw),
    };

    const count = await this.wordService.getFilteredDictionaryWordsCount(req.user.id, filters);
    return { count };
  }

  @Post('dictionary/progress/batch')
  @ApiOperation({ summary: 'Update SRS progress for dictionary repeat session (success/fail per word)' })
  async updateDictionarySrsBatch(
    @Req() req: JwtRequest,
    @Body() body: any,
  ) {
    const rawWords = Array.isArray(body) ? body : (body?.words || []);

    const cleanWords = rawWords
      .map((w: any) => ({
        id: Number(w.id),
        userWordId: w.userWordId !== null && w.userWordId !== undefined ? Number(w.userWordId) : undefined,
        success: w.success === true || w.success === 'true' || w.success === 1,
      }))
      .filter((w: any) => !isNaN(w.id) && w.id > 0);

    return this.wordService.updateDictionarySrsBatch(req.user.id, cleanWords);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single user word by UserWord id' })
  async getUserWordById(
    @Req() req: JwtRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const word = await this.wordService.getUserWordById(req.user.id, id);
    if (!word) throw new NotFoundException('Слово не знайдено');
    return word;
  }

@Post('progress/batch')
  @ApiOperation({ summary: 'Batch update word progress (queue-based, high performance)' })
  async updateUserWordProgressBatch(
    @Req() req: any,
    @Body() body: any,
  ): Promise<ProgressBatchResult> {
    // 🔧 Детальні логи (сире тіло кожного запиту) — лише на рівні debug.
    const logger = this.logger;

    const rawWords = Array.isArray(body) ? body : (body?.words || []);
    logger.debug(`progress/batch user=${req.user?.id}, слів у запиті: ${rawWords.length}`);

    if (rawWords.length === 0) {
      return { success: true, updatedIds: [], failedIds: [] };
    }

    const cleanWords = rawWords.map((w: any) => {
      const id = Number(w.id);
      const userWordId =
        w.userWordId !== null && w.userWordId !== undefined && !isNaN(Number(w.userWordId))
          ? Number(w.userWordId)
          : null;

      const p = w.progress || {};

      const step1 = p.step1 === true || p.step1 === 'true' || p.step1 === 1 || p.step1 === '1';
      const step3 = p.step3 === true || p.step3 === 'true' || p.step3 === 1 || p.step3 === '1';
      const step3Skipped =
        p.step3Skipped === true || p.step3Skipped === 'true' || p.step3Skipped === 1 || p.step3Skipped === '1';

      const partial = w.partial === true || w.partial === 'true';

      return { id, userWordId, step1, step3, step3Skipped, partial };
    }).filter((w: any) => {
      const isValid = !isNaN(w.id) && w.id > 0;
      if (!isValid) {
        logger.debug(
          `⚠️ Слово відкинуто через невалідний глобальний id: ${JSON.stringify(w)}. ` +
          `Це означає, що фронтенд не передав word.id — перевір payload.`,
        );
      }
      return isValid;
    });

    logger.debug(`ОЧИЩЕНІ ДАНІ, ЩО ЙДУТЬ В СЕРВІС: ${JSON.stringify(cleanWords)}`);

    const result = await this.wordService.updateUserWordProgressBatch(req.user.id, cleanWords);

    logger.debug(`РЕЗУЛЬТАТ ОБРОБКИ СЕРВІСОМ: ${JSON.stringify(result)}`);

    await this.cacheService.clearUserProgressCaches(req.user.id);
    return result;
  }



  @Post('progress/:id')
  @ApiOperation({ summary: 'Single word progress tap (NEW→LEARNING→LEARNED→LEARNING)' })
  async updateProgress(
    @Req() req: JwtRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.wordService.updateUserWordProgress(req.user.id, id);
  }


  @Post('progress/reset-by-level')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reset all words progress by CEFR level (or all)' })
  async resetUserProgressByLevel(
    @Req() req: JwtRequest,
    @Body() resetDto: ResetProgressByLevelDto,
  ) {
    return this.wordService.resetUserProgressByLevel(req.user.id, resetDto.level);
  }

  @Patch('user-word/:id/toggle-favorite')
  @ApiOperation({ summary: 'Toggle favorite status for a user word (inverts true/false)' })
  async toggleFavorite(
    @Req() req: JwtRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.wordService.toggleFavorite(req.user.id, id);
  }

  @Patch('user-word/:id/notes')
  @ApiOperation({ summary: 'Update custom notes for a user word (max 400 chars)' })
  async updateUserWordNotes(
    @Req() req: JwtRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body('notes') notes: string,
  ) {
    if (notes && notes.length > 400) {
      throw new BadRequestException('Нотатки не можуть перевищувати 400 символів');
    }
    return this.wordService.updateUserWordNotes(req.user.id, id, notes);
  }


  @Post('reset-progress-batch')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reset progress for a list of word ids' })
  async resetUserProgressBatch(
    @Req() req: JwtRequest,
    @Body() resetProgressDto: ResetProgressDto,
  ) {
    return this.wordService.resetUserProgressBatch(req.user.id, resetProgressDto.ids);
  }

  @Patch('user-word/:id')
  @ApiOperation({ summary: 'Update custom userText / userTranslation for a word' })
  async editUserWord(
    @Req() req: JwtRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body('userText') userText?: string,
    @Body('userTranslation') userTranslation?: string,
  ) {
    return this.wordService.updateUserWordCustomData(
      req.user.id,
      id,
      userText,
      userTranslation,
    );
  }

  @Delete('remove/:id')
  @ApiOperation({ summary: 'Remove a word from user dictionary' })
  async deleteUserWord(
    @Req() req: JwtRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.wordService.deleteUserWord(req.user.id, id);
  }

  @Delete('remove-batch')
  @ApiOperation({ summary: 'Remove multiple words from user dictionary' })
  async deleteUserWordsBatch(
    @Req() req: JwtRequest,
    @Body() deleteWordsDto: DeleteWordsDto,
  ) {
    return this.wordService.deleteUserWordsBatch(req.user.id, deleteWordsDto.ids);
  }
}