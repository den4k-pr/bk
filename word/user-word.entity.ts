import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { Word } from './word.entity';
import { User } from 'src/user/user.entity';

export enum StudyStatus {
  ALL = 'all',
  NEW = 'new',
  LEARNING = 'learning',
  LEARNED = 'learned',
}

export type DictionarySourceType = 'package' | 'book' | 'manual';

// 🔧 Індекси для гарячих запитів ("усі записи юзера"). Postgres не
// створює індексів на FK-колонках автоматично — без них кожен запит
// сканував усю таблицю. Звичайні (не unique) — безпечно для наявних даних.
@Index('IDX_user_word_user_word', ['user', 'word'])
@Index('IDX_user_word_word', ['word'])
@Entity()
export class UserWord {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, user => user.userWords, { onDelete: 'CASCADE' })
  user: User;

  @ManyToOne(() => Word, word => word.userWords, { eager: true, onDelete: 'CASCADE' })
  word: Word;

  @Column({ nullable: true })
  userTranslation: string;

  @Column({ type: 'varchar', length: 400, nullable: true })
  notes: string | null;

  @Column({ default: false })
  isFavorite: boolean;

  @Column({ nullable: true })
  userText: string;

  @Column({ type: 'text', nullable: true, default: StudyStatus.NEW })
  status: StudyStatus;

  @Column({ type: 'date', nullable: true })
  wordOfTheDayDate: string | null;

  @Column({ type: 'varchar', length: 20, default: 'manual' })
  sourceType: DictionarySourceType;

  @Column({ type: 'int', nullable: true })
  sourceBookId: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  sourceBookTitle: string | null;

  // Звідки саме додано слово з книги: речення і форма в тексті ("trained").
  // Дає змогу показати оригінальний приклад і переперевірити значення.
  @Column({ type: 'varchar', length: 400, nullable: true })
  sourceSentence: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  sourceSurface: string | null;

  @Column({ type: 'int', default: 0 })
  srsLevel: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextReviewAt: Date;

  @CreateDateColumn()
  addedAt: Date;
}