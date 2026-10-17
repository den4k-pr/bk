import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CacheService } from 'src/cache/cache.service';
import { AiCacheEntry } from './ai-cache-entry.entity';

/**
 * Кеш відповідей ШІ у два шари: Redis (швидко) → база (назавжди).
 *  - get: Redis; немає — база (і знову кладемо в Redis); немає — null.
 *  - set: база + Redis.
 * Збій бази чи Redis ніколи не ламає запит — лише логується (тоді просто
 * буде ще один виклик ШІ).
 */
@Injectable()
export class DurableAiCacheService {
  private readonly logger = new Logger(DurableAiCacheService.name);
  private static readonly REDIS_TTL_SECONDS = 30 * 24 * 3600;

  constructor(
    private readonly cacheService: CacheService,
    @InjectRepository(AiCacheEntry) private readonly repo: Repository<AiCacheEntry>,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const hot = await this.cacheService.get<T>(key);
      if (hot !== null && hot !== undefined) return hot;
    } catch {
      // Redis недоступний — йдемо в базу
    }

    try {
      const row = await this.repo.findOne({ where: { key } });
      if (!row) return null;
      this.cacheService.set(key, row.value, DurableAiCacheService.REDIS_TTL_SECONDS).catch(() => {});
      return row.value as T;
    } catch (error) {
      this.logger.warn(`Не вдалося прочитати AI-кеш з бази (${key}): ${(error as Error)?.message}`);
      return null;
    }
  }

  async set(key: string, kind: string, value: unknown): Promise<void> {
    try {
      await this.repo.upsert({ key, kind, value: value as any }, ['key']);
    } catch (error) {
      this.logger.warn(`Не вдалося записати AI-кеш у базу (${key}): ${(error as Error)?.message}`);
    }
    try {
      await this.cacheService.set(key, value, DurableAiCacheService.REDIS_TTL_SECONDS);
    } catch {
      // лише швидкий шар — база вже має запис
    }
  }
}
