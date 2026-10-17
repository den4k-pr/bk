import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
  Index,
  Unique,
} from 'typeorm';
import { UserWord } from './user-word.entity';

/**
 * Розширено порівняно з початковим варіантом: додано значення, які
 * реально повертає phrase-structure-classifier.ts для фраз/ідіом/
 * фразових дієслів ('phrasal_verb', 'idiom', 'fixed_expression',
 * 'prepositional_phrase', 'conjunction_phrase') та 'none' для випадків,
 * коли частина мови не визначається (грам. конструкції на кшталт "do not").
 *
 * Це БЕЗПЕЧНО розширювати — колонка в БД це звичайний varchar(20)
 * без CHECK-обмеження, тобто жодної міграції не потрібно, це суто
 * рівень типів TypeScript.
 */
export type PartOfSpeech =
  | 'noun'
  | 'verb'
  | 'adjective'
  | 'adverb'
  | 'pronoun'
  | 'preposition'
  | 'conjunction'
  | 'interjection'
  | 'phrasal_verb'
  | 'phrase'
  | 'idiom'
  | 'numeral'
  | 'none';

// 🔧 Статистика/вибірки програм завжди фільтрують за packageId.
@Index('IDX_word_package', ['packageId'])
// ⚡ Пошук слова при тапі в читалці — за LOWER(text) і за forms. Ці індекси
// (вираз і GIN) TypeORM не вміє описати, тож вони створюються при старті
// (src/database/db-indexes.service.ts); synchronize: false — щоб
// synchronize: true їх не видаляв.
@Index('IDX_word_text_lower', { synchronize: false })
@Index('IDX_word_forms_gin', { synchronize: false })
// Одне написання може мати кілька словникових значень з різною частиною
// мови ("train" — поїзд / тренувати). Основне (перше) значення має
// senseKey = '' — так поводяться всі наявні записи, тож унікальність
// "одне слово = один запис" для них не змінюється. Додаткові значення
// отримують senseKey = частина мови ('verb', 'noun', …).
@Unique('UQ_word_text_sense', ['text', 'senseKey'])
@Entity()
export class Word {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  text: string;

  @Column({ type: 'varchar', length: 20, default: '' })
  senseKey: string;

  @Column()
  translation: string;

  // Поля, які заповнюються AI, тепер мають nullable: true,
  // щоб запис успішно створювався, навіть якщо AI не повернув дані для цих полів
  @Column('text', { array: true, nullable: true })
  definitions: string[];

  @Column('text', { nullable: true })
  description: string;

  @Column({ nullable: true })
  pronunciation: string;

  @Column({
    type: 'varchar',
    length: 20,
    nullable: true, // або false, якщо заповнюєш одразу при створенні
  })
  partOfSpeech: PartOfSpeech;

  @Column('text', { array: true, nullable: true })
  antonyms: string[];

  @Column({ nullable: true })
  level: string;

  @Column({ type: 'boolean', default: false })
  isProperNoun: boolean;

  @Column({ type: 'jsonb', nullable: true })
  exampleHighlights: Array<{ start: number; end: number } | null>;

  @Column('text', { array: true, nullable: true, default: [] })
  forms: string[];

  // Дослівний переклад конкретних ФОРМ слова ("sharing" → "поділ / ділячись"),
  // на відміну від перекладу леми ("share" → "ділитися"). Ключ — форма в тексті.
  @Column({ type: 'jsonb', nullable: true })
  surfaceTranslations: Record<string, string> | null;

  // Схожі фрази для картки фрази: англ. фраза, переклад і стиль ("розмовне", "ввічливе"...).
  @Column({ type: 'jsonb', nullable: true })
  similarPhrases: Array<{ en: string; uk: string; tag?: string }> | null;

  @Column('text', { array: true, nullable: true })
  examples: string[];

  @Column({ type: 'text', nullable: true })
  learningDescription: string | null;

  @Column({ type: 'text', nullable: true })
  bookDescription: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'varchar', default: 'word' })
  type: 'word' | 'phrase' | 'phrasal_verb';

  @OneToMany(() => UserWord, (userWord) => userWord.word)
  userWords: UserWord[];

  @Column({ nullable: true })
  packageId: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  category: string | null;
}