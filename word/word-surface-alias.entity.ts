import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Word } from './word.entity';

export type WordSurfaceAliasSource = 'admin' | 'ai';

/**
 * Відповідність "написання в тексті → словниковий запис".
 *
 *  - source = 'admin' — ручний виняток з адмінки. Має найвищий пріоритет:
 *    натискання на це слово ЗАВЖДИ відкриває вказаний запис, незалежно від
 *    правил і AI ("wooden" → wooden, "trained" → train (дієслово)).
 *  - source = 'ai' — запам'ятоване рішення AI для однозначних форм
 *    ("slain" → slay), щоб повторні натискання не викликали AI знову.
 *
 * Видалення запису словника видаляє і його псевдоніми (CASCADE).
 */
@Entity('word_surface_alias')
@Index('UQ_word_surface_alias_surface', ['surface'], { unique: true })
export class WordSurfaceAlias {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 100 })
  surface: string;

  @ManyToOne(() => Word, { onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'wordId' })
  word: Word;

  @Column({ type: 'int' })
  wordId: number;

  @Column({ type: 'varchar', length: 10, default: 'admin' })
  source: WordSurfaceAliasSource;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
