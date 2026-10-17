import { IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateWordDto {
    @IsNotEmpty()
    @IsString()
    text: string;

    @IsNotEmpty()
    @IsString()
    translation: string;

    @IsArray()
    @IsString({ each: true })
    definitions: string[];

    @IsString()
    learningDescription: string;

    @IsString()
    bookDescription: string;

    @IsOptional()
    @IsBoolean()
    isProperNoun?: boolean;

    @IsNotEmpty()
    @IsString()
    description: string;

    @IsNotEmpty()
    @IsString()
    pronunciation: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    antonyms?: string[];

    @IsArray()
    @IsString({ each: true })
    examples: string[];

    @IsNotEmpty()
    @IsString()
    @IsIn(['A1', 'A2', 'B1', 'B2', 'C1', 'C2'])
    level: string;
}

export class WordProgressItemDto {
  @IsInt()
  id: number;

  @IsBoolean()
  step1: boolean;

  @IsBoolean()
  step3: boolean;

  // Збереження прогресу при виході з карток посеред циклу: денний ліміт
  // карток списується лише за ПОВНІСТЮ пройдений цикл (3 слова), тож такі
  // записи ліміт не чіпають.
  @IsOptional()
  @IsBoolean()
  partial?: boolean;
}

export class UpdateUserWordProgressBatchDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WordProgressItemDto)
  words: WordProgressItemDto[];
}

export class ResetProgressByLevelDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['all', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'])
  level: string;
}

export class UpdateUserWordDto {
    @IsNotEmpty()
    userWordId: number;

    @IsOptional()
    @IsString()
    userText?: string;

    @IsOptional()
    @IsString()
    userTranslation?: string;
}

export class DictionaryProgressItemDto {
  @IsInt()
  id: number;

  @IsOptional()
  @IsInt()
  userWordId?: number;

  @IsBoolean()
  success: boolean;
}

export class DictionaryProgressBatchDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DictionaryProgressItemDto)
  words: DictionaryProgressItemDto[];
}

export class DictionaryFiltersCountDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  bookIds?: string[];

  @IsOptional()
  @IsBoolean()
  packages?: boolean;

  @IsOptional()
  @IsBoolean()
  manual?: boolean;
}