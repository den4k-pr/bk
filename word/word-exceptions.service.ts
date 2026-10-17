import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Word } from './word.entity';
import { WordSurfaceAlias } from './word-surface-alias.entity';
import { WordLookupReport, WordLookupReportStatus } from './word-lookup-report.entity';
import { WordGenerationService } from './words-details/word-generation.service';

const SURFACE_RE = /^[a-z]{2,40}$/;

/**
 * Адмінка "Винятки слів": ручні відповідності "слово в тексті → запис
 * словника" та скарги користувачів з читалки.
 */
@Injectable()
export class WordExceptionsService {
  constructor(
    @InjectRepository(WordSurfaceAlias) private readonly aliasRepo: Repository<WordSurfaceAlias>,
    @InjectRepository(WordLookupReport) private readonly reportRepo: Repository<WordLookupReport>,
    @InjectRepository(Word) private readonly wordRepo: Repository<Word>,
    private readonly wordGenService: WordGenerationService,
  ) {}

  private normalizeSurface(raw: string): string {
    const surface = String(raw ?? '').replace(/[’‘]/g, "'").trim().toLowerCase();
    if (!SURFACE_RE.test(surface)) {
      throw new BadRequestException('Слово має містити лише латинські літери (без пробілів)');
    }
    return surface;
  }

  private present(alias: WordSurfaceAlias) {
    return {
      id: alias.id,
      surface: alias.surface,
      source: alias.source,
      note: alias.note,
      createdAt: alias.createdAt,
      updatedAt: alias.updatedAt,
      word: alias.word
        ? {
            id: alias.word.id,
            text: alias.word.text,
            senseKey: alias.word.senseKey,
            partOfSpeech: alias.word.partOfSpeech,
            translation: alias.word.translation,
          }
        : null,
    };
  }

  async listAliases(params: { search?: string; source?: string; limit?: number; offset?: number }) {
    const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 500);
    const offset = Math.max(Number(params.offset) || 0, 0);
    const qb = this.aliasRepo
      .createQueryBuilder('alias')
      .leftJoinAndSelect('alias.word', 'word')
      .orderBy('alias.updatedAt', 'DESC')
      .take(limit)
      .skip(offset);
    const search = (params.search ?? '').trim().toLowerCase();
    if (search) qb.andWhere('(alias.surface LIKE :s OR LOWER(word.text) LIKE :s)', { s: `%${search}%` });
    if (params.source === 'admin' || params.source === 'ai') qb.andWhere('alias.source = :src', { src: params.source });
    const [items, total] = await qb.getManyAndCount();
    return { items: items.map(a => this.present(a)), total };
  }

  async upsertAlias(data: { surface: string; wordId: number; note?: string }) {
    const surface = this.normalizeSurface(data.surface);
    const wordId = Number(data.wordId);
    if (!Number.isInteger(wordId) || wordId <= 0) throw new BadRequestException('Оберіть запис словника');
    const word = await this.wordRepo.findOne({ where: { id: wordId } });
    if (!word) throw new NotFoundException('Запис словника не знайдено');

    let alias = await this.aliasRepo.findOne({ where: { surface } });
    if (alias) {
      alias.wordId = word.id;
      alias.source = 'admin';
      alias.note = data.note?.trim() || alias.note || null;
    } else {
      alias = this.aliasRepo.create({ surface, wordId: word.id, source: 'admin', note: data.note?.trim() || null });
    }
    const saved = await this.aliasRepo.save(alias);
    const full = await this.aliasRepo.findOne({ where: { id: saved.id }, relations: ['word'] });
    return this.present(full!);
  }

  async deleteAlias(id: number) {
    const res = await this.aliasRepo.delete(id);
    if (!res.affected) throw new NotFoundException('Виняток не знайдено');
    return { success: true };
  }

  /** Записи словника для вибору цілі винятку (усі значення слова). */
  async findWordSenses(text: string) {
    const q = String(text ?? '').trim().toLowerCase();
    if (!q) return [];
    const words = await this.wordRepo
      .createQueryBuilder('word')
      .where('LOWER(word.text) = :q', { q })
      .orWhere('LOWER(word.text) LIKE :p', { p: `${q}%` })
      .orderBy('CASE WHEN LOWER(word.text) = :q THEN 0 ELSE 1 END', 'ASC')
      .addOrderBy('LENGTH(word.text)', 'ASC')
      .addOrderBy('word.id', 'ASC')
      .setParameter('q', q)
      .take(30)
      .getMany();
    return words.map(w => ({
      id: w.id,
      text: w.text,
      senseKey: w.senseKey,
      partOfSpeech: w.partOfSpeech,
      translation: w.translation,
      type: w.type,
    }));
  }

  diagnose(surface: string, context?: string) {
    if (!String(surface ?? '').trim()) throw new BadRequestException('Вкажіть слово');
    return this.wordGenService.diagnoseSingleWord(surface, context);
  }

  async listReports(params: { status?: string; limit?: number; offset?: number }) {
    const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 500);
    const offset = Math.max(Number(params.offset) || 0, 0);
    const status = (['open', 'resolved', 'dismissed'] as const).find(s => s === params.status) ?? 'open';
    const [items, total] = await this.reportRepo.findAndCount({
      where: { status },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }

  async setReportStatus(id: number, status: string) {
    const allowed: WordLookupReportStatus[] = ['open', 'resolved', 'dismissed'];
    if (!allowed.includes(status as WordLookupReportStatus)) throw new BadRequestException('Невідомий статус');
    const res = await this.reportRepo.update(id, { status: status as WordLookupReportStatus });
    if (!res.affected) throw new NotFoundException('Скаргу не знайдено');
    return { success: true };
  }
}
