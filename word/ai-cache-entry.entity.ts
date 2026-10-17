import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Постійне сховище відповідей OpenAI, які залежать лише від вхідних даних
 * (слово + речення книжки, український запит тощо). Раніше вони жили лише
 * в Redis на 30 днів: після закінчення терміну або перезапуску Redis ті
 * самі запити йшли в OpenAI повторно — за гроші. Тепер відповідь
 * отримується з OpenAI ОДИН раз і далі береться з бази.
 *
 * key — той самий ключ, що й у Redis (з версією промпту: зміна промпту =
 * новий ключ, старі записи просто не використовуються).
 */
@Entity('ai_cache_entry')
@Index('IDX_ai_cache_entry_kind', ['kind'])
export class AiCacheEntry {
  @PrimaryColumn({ type: 'varchar', length: 160 })
  key: string;

  @Column({ type: 'varchar', length: 40 })
  kind: string;

  @Column({ type: 'jsonb' })
  value: unknown;

  @CreateDateColumn()
  createdAt: Date;
}
