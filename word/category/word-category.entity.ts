import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Реєстр категорій слів у межах конкретної навчальної програми (пакета).
 *
 * Навмисно НЕ зберігає лічильники (totalWords / learnedWords) як власні
 * колонки — вони завжди рахуються "наживо" запитом до Word + 
 * UserWordProgress (аналогічно ProgramService.getProgramStats), щоб
 * статистика ніколи не розходилась з реальним станом бази, так само,
 * як це вже зроблено для типів слів (word/phrase/phrasal_verb).
 *
 * Унікальність (packageId, name) — щоб AI/адмін не міг випадково
 * створити дві категорії з однаковою назвою в одному пакеті.
 */
@Entity()
@Index(['packageId', 'name'], { unique: true })
export class WordCategory {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  packageId: number;

  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ default: 0 })
  sortOrder: number;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}