import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WordController } from './word.controller';
import { WordService } from './word.service';
import { WordGenerationService } from './words-details/word-generation.service';
import { SpellCorrectionService } from './spell-correction.service';
import { ExampleHighlightAiService } from './example-highlight-ai.service';
import { Word } from './word.entity';
import { UserWord } from './user-word.entity';
import { User } from 'src/user/user.entity';
import { ProgramPackage } from 'src/program/entities/program-package.entity';
import { UserProgramAccess } from 'src/program/entities/program-access.entity';
import { UserWordProgress } from 'src/user-word-progress/user-word-progress.entity';
import { PhraseLibrary } from 'src/phrase-library/phrase-library.entity';
import { CacheModule } from 'src/cache/cache.module';
import { UserWordProgressModule } from 'src/user-word-progress/user-word-progress.module';
import { DailyLimitModule } from 'src/daily-limit/daily-limit.module';
import { WordCategory } from './category/word-category.entity';
import { WordCategoryService } from './category/word-category.service';
import { ExampleShorteningAiService } from './words-details/example-shortening-ai.service';
import { WordSurfaceAlias } from './word-surface-alias.entity';
import { WordLookupReport } from './word-lookup-report.entity';
import { WordExceptionsService } from './word-exceptions.service';
import { AiCacheEntry } from './ai-cache-entry.entity';
import { DurableAiCacheService } from './durable-ai-cache.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Word,
      WordCategory,
      UserWord,
      User,
      ProgramPackage,
      UserProgramAccess,
      UserWordProgress,
      PhraseLibrary,
      WordSurfaceAlias,
      WordLookupReport,
      AiCacheEntry,
    ]),
    CacheModule,
    forwardRef(() => UserWordProgressModule),
    DailyLimitModule,
  ],
  controllers: [WordController],
  providers: [
    WordService,
    WordCategoryService,
    WordGenerationService,
    DurableAiCacheService,
    ExampleHighlightAiService,
    // 🟢 НОВЕ: пакетне AI-скорочення прикладів (потрібен @InjectRepository(Word)
    // — забезпечено через TypeOrmModule.forFeature вище, CacheService — через
    // CacheModule, і WordService — він теж провайдер цього самого модуля).
    ExampleShorteningAiService,
    SpellCorrectionService,
    WordExceptionsService,
  ],
  exports: [
    WordService,
    WordCategoryService,
    ExampleHighlightAiService,
    // 🟢 НОВЕ: експортуємо, щоб AdminWordController (у AdminModule, який
    // імпортує WordModule) міг інжектнути ExampleShorteningAiService так
    // само, як він уже інжектить ExampleHighlightAiService.
    ExampleShorteningAiService,
    SpellCorrectionService,
    WordExceptionsService,
  ],
})
export class WordModule {}