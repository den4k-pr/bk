import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export type WordLookupReportStatus = 'open' | 'resolved' | 'dismissed';

/**
 * Скарга користувача з читалки "не те слово / неточний переклад".
 * Адмін бачить слово, речення і що саме відкрилось, і може одразу
 * створити виняток (WordSurfaceAlias).
 */
@Entity('word_lookup_report')
@Index('IDX_word_lookup_report_status', ['status'])
export class WordLookupReport {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int', nullable: true })
  userId: number | null;

  /** Слово так, як воно було в тексті ("trained"). */
  @Column({ type: 'varchar', length: 100 })
  surface: string;

  @Column({ type: 'varchar', length: 400, nullable: true })
  context: string | null;

  /** Запис, який показала читалка. */
  @Column({ type: 'int', nullable: true })
  wordId: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  wordText: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  wordTranslation: string | null;

  @Column({ type: 'int', nullable: true })
  bookId: number | null;

  @Column({ type: 'varchar', length: 12, default: 'open' })
  status: WordLookupReportStatus;

  @CreateDateColumn()
  createdAt: Date;
}
