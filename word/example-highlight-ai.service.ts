import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OpenAI } from 'openai';
import { Word } from './word.entity';
import { CacheService } from 'src/cache/cache.service';
import { WordService } from './word.service';
import { findEnglishHighlight, findUkrainianHighlight } from './example-highlight.util';

type ExampleHighlight = { start: number; end: number } | null;

export interface AiHighlightJobStats {
  status: 'idle' | 'running' | 'completed' | 'failed';
  totalCandidates: number;
  processedWords: number;
  updatedWords: number;
  regeneratedPairs: number;
  unresolvedWords: number;
  skippedAlreadyDone: number;
  failedWords: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

interface AiWordBatchInput {
  id: number;
  text: string;
  translation: string;
  examples: string[];
}

interface AiWordBatchResultItem {
  id: number;
  matches: (string | null)[];
}

interface PairRegenerationTask {
  key: string;
  wordId: number;
  enIndex: number;
  uaIndex: number;
  headword: string;
  translation: string;
  level: string | null;
  currentEn: string;
  currentUa: string;
}

interface PairRegenerationResultItem {
  key: string;
  en: string;
  ua: string;
  enMatch: string | null;
  uaMatch: string | null;
}

const SCAN_PAGE_SIZE = 300;
const WORDS_PER_MATCH_REQUEST = 20;
const PAIRS_PER_REGEN_REQUEST = 15;
const REQUEST_DELAY_MS = 350;
const MODEL = 'gpt-4o-mini';

// Символи, які вважаємо частиною слова (літери EN/UA, апострофи, дефіс) —
// щоб підсвітка розширювалась на ціле відмінюване/відмінюване слово
// («tulip» у «tulips», «тюльпан» у «тюльпани»), а не лише на лему.
const WORD_CHAR = /[A-Za-zА-Яа-яЁёІіЇїЄєҐґ'’ʼ-]/;

@Injectable()
export class ExampleHighlightAiService {
  private readonly logger = new Logger(ExampleHighlightAiService.name);
  private readonly openai: OpenAI;

  private job: AiHighlightJobStats = this.emptyJobStats();

  private static openAiQuotaBlockedUntil: number | null = null;
  private static readonly QUOTA_COOLDOWN_MS = 60 * 1000;

  constructor(
    @InjectRepository(Word)
    private readonly wordRepo: Repository<Word>,
    private readonly cacheService: CacheService,
  ) {
    this.openai = new OpenAI({ apiKey: process.env.AI_KEY });
  }

  private emptyJobStats(): AiHighlightJobStats {
    return {
      status: 'idle',
      totalCandidates: 0,
      processedWords: 0,
      updatedWords: 0,
      regeneratedPairs: 0,
      unresolvedWords: 0,
      skippedAlreadyDone: 0,
      failedWords: 0,
      startedAt: null,
      finishedAt: null,
      lastError: null,
    };
  }

  getStatus(): AiHighlightJobStats {
    return { ...this.job };
  }

  startJob(): { started: boolean; message: string } {
    if (this.job.status === 'running') {
      return { started: false, message: 'Обробка вже триває' };
    }

    this.job = this.emptyJobStats();
    this.job.status = 'running';
    this.job.startedAt = new Date().toISOString();

    this.runJob().catch((err) => {
      this.job.status = 'failed';
      this.job.finishedAt = new Date().toISOString();
      this.job.lastError = err?.message || String(err);
      this.logger.error('AI highlight job crashed', err);
    });

    return { started: true, message: 'Обробку запущено у фоні' };
  }

  private isOpenAiBlocked(): boolean {
    const until = ExampleHighlightAiService.openAiQuotaBlockedUntil;
    return !!until && Date.now() < until;
  }

  private markQuotaExhausted(error: any): void {
    // insufficient_quota — немає коштів (довга пауза); інша 429 — ліміт
    // запитів за хвилину (пауза кілька секунд).
    const code = error?.code ?? error?.error?.code;
    const isQuota = code === 'insufficient_quota';
    if (!isQuota && error?.status !== 429) return;
    const cooldownMs = isQuota ? ExampleHighlightAiService.QUOTA_COOLDOWN_MS : 5_000;
    ExampleHighlightAiService.openAiQuotaBlockedUntil = Math.max(
      ExampleHighlightAiService.openAiQuotaBlockedUntil ?? 0,
      Date.now() + cooldownMs,
    );
    this.logger.error(
      `🚫 OpenAI 429 [${isQuota ? 'НЕМАЄ КОШТІВ' : 'ліміт запитів'}] code=${code ?? '-'}: ` +
        `"${String(error?.error?.message ?? error?.message ?? '').slice(0, 300)}". Пауза ШІ ${cooldownMs / 1000}с.`,
    );
  }

  private normalizeForLiteralMatch(text: string): string {
    return (text || '').trim().replace(/[.!?]+$/, '');
  }

  private tryLiteralMatch(exampleText: string, rawTarget: string): ExampleHighlight {
    const target = this.normalizeForLiteralMatch(rawTarget);
    if (!target) return null;

    const isPhrase = target.includes(' ');

    if (isPhrase) {
      return this.locateSubstring(exampleText, target);
    }

    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundaryRegex = new RegExp(`\\b${escaped}\\b`, 'i');
    const match = boundaryRegex.exec(exampleText);
    if (!match) return null;

    return { start: match.index, end: match.index + match[0].length };
  }

  private needsReprocessing(word: Word): boolean {
    if (!word.examples || word.examples.length === 0) return false;

    const highlights = word.exampleHighlights;
    if (!highlights || !Array.isArray(highlights)) return true;
    if (highlights.length !== word.examples.length) return true;

    for (let i = 0; i < word.examples.length; i++) {
      const exampleText = word.examples[i];
      const hasText = !!exampleText && exampleText.trim().length > 0;
      if (!hasText) continue;

      const highlight = highlights[i];

      if (highlight === null) return true;
      if (!this.isHighlightSane(exampleText, highlight)) return true;

      const isEnglishExample = i % 2 === 0;
      const target = isEnglishExample ? word.text : word.translation;

      if (target && target.trim().includes(' ')) {
        const normalizedTarget = this.normalizeForLiteralMatch(target).toLowerCase();
        const slice = exampleText.slice(highlight.start, highlight.end).trim().toLowerCase();
        if (slice !== normalizedTarget) return true;
      } else if (target && target.trim()) {
        // Одиночне слово: підсвітка має покривати ЦІЛЕ відмінюване слово
        // (разом із закінченнями), а не обриватися на лемі («tulip» у «tulips»).
        if (highlight.end < exampleText.length && WORD_CHAR.test(exampleText[highlight.end])) {
          return true;
        }
        if (highlight.start > 0 && WORD_CHAR.test(exampleText[highlight.start - 1])) {
          return true;
        }
      }
    }

    return false;
  }

  private isHighlightSane(exampleText: string, highlight: ExampleHighlight): boolean {
    if (!highlight) return false;
    const { start, end } = highlight;
    if (typeof start !== 'number' || typeof end !== 'number') return false;
    if (start < 0 || end <= start || end > exampleText.length) return false;
    const slice = exampleText.slice(start, end).trim();
    return slice.length >= 1;
  }

  private async runJob(): Promise<void> {
    const candidates: Word[] = [];
    const pageSize = SCAN_PAGE_SIZE;
    let offset = 0;
    let scanning = true;

    while (scanning) {
      const page = await this.wordRepo.find({
        order: { id: 'ASC' },
        take: pageSize,
        skip: offset,
      });

      if (page.length === 0) {
        scanning = false;
        break;
      }

      for (const word of page) {
        if (this.needsReprocessing(word)) {
          candidates.push(word);
        } else {
          this.job.skippedAlreadyDone += 1;
        }
      }

      offset += pageSize;
      if (page.length < pageSize) scanning = false;
    }

    this.job.totalCandidates = candidates.length;
    this.logger.log(
      `[AI-HIGHLIGHTS] Знайдено ${candidates.length} слів для переобробки, ${this.job.skippedAlreadyDone} вже коректні — пропущено`,
    );

    for (let i = 0; i < candidates.length; i += WORDS_PER_MATCH_REQUEST) {
      if (this.isOpenAiBlocked()) {
        this.logger.warn('[AI-HIGHLIGHTS] AI заблоковано через квоту — зупиняю обробку до наступного запуску');
        break;
      }

      const chunk = candidates.slice(i, i + WORDS_PER_MATCH_REQUEST);
      await this.processChunk(chunk);

      if (i + WORDS_PER_MATCH_REQUEST < candidates.length) {
        await this.sleep(REQUEST_DELAY_MS);
      }
    }

    this.job.status = 'completed';
    this.job.finishedAt = new Date().toISOString();

    if (this.job.updatedWords > 0) {
      await this.cacheService.clear(WordService.ALL_WORDS_CACHE_KEY);
      await this.cacheService.clear(WordService.ALL_WORDS_SHORT_CACHE_KEY);
    }

    this.logger.log(
      `[AI-HIGHLIGHTS] Готово. Оброблено=${this.job.processedWords}, оновлено=${this.job.updatedWords}, перегенеровано пар=${this.job.regeneratedPairs}, нерозв'язано слів=${this.job.unresolvedWords}, помилок=${this.job.failedWords}`,
    );
  }

  private async processChunk(words: Word[]): Promise<void> {
    const input: AiWordBatchInput[] = words.map((w) => ({
      id: w.id,
      text: w.text,
      translation: w.translation,
      examples: w.examples || [],
    }));

    let aiResults: AiWordBatchResultItem[] | null = null;

    try {
      aiResults = await this.callAiForMatchBatch(input);
    } catch (error: any) {
      this.markQuotaExhausted(error);
      this.logger.error('[AI-HIGHLIGHTS] AI match batch call failed', error);
    }

    const aiResultsById = new Map((aiResults || []).map((r) => [r.id, r]));

    const wordHighlights = new Map<number, ExampleHighlight[]>();
    const regenerationTasks: PairRegenerationTask[] = [];

    for (const word of words) {
      const examples = word.examples || [];
      const highlights: ExampleHighlight[] = new Array(examples.length).fill(null);
      const aiResult = aiResultsById.get(word.id);

      for (let index = 0; index < examples.length; index++) {
        const exampleText = examples[index];
        if (!exampleText || !exampleText.trim()) continue;

        const isEnglishExample = index % 2 === 0;

        // Детермінований пошук одразу шукає відмінювану/відмінювану форму
        // (повністю, разом із закінченнями) — без витрат токенів AI.
        const literalHighlight = isEnglishExample
          ? findEnglishHighlight(exampleText, [word.text, ...(word.forms || [])].filter(Boolean))
          : findUkrainianHighlight(exampleText, word.translation);
        if (literalHighlight) {
          highlights[index] = literalHighlight;
          continue;
        }

        const matchedText = aiResult?.matches?.[index] ?? null;
        if (matchedText) {
          const located = this.locateSubstring(exampleText, matchedText);
          if (located) {
            highlights[index] = located;
          }
        }
      }

      wordHighlights.set(word.id, highlights);

      const pairCount = Math.floor(examples.length / 2);
      for (let pair = 0; pair < pairCount; pair++) {
        const enIndex = pair * 2;
        const uaIndex = pair * 2 + 1;

        const enText = examples[enIndex];
        const uaText = examples[uaIndex];
        const enOk = !enText || !enText.trim() || highlights[enIndex] !== null;
        const uaOk = !uaText || !uaText.trim() || highlights[uaIndex] !== null;

        if (!enOk || !uaOk) {
          regenerationTasks.push({
            key: `${word.id}:${pair}`,
            wordId: word.id,
            enIndex,
            uaIndex,
            headword: word.text,
            translation: word.translation,
            level: word.level ?? null,
            currentEn: enText || '',
            currentUa: uaText || '',
          });
        }
      }
    }

    if (regenerationTasks.length > 0) {
      await this.runRegenerationTasks(regenerationTasks, words, wordHighlights);
    }

    for (const word of words) {
      this.job.processedWords += 1;

      try {
        const highlights = wordHighlights.get(word.id) || [];
        const hasUnresolved = (word.examples || []).some(
          (exampleText, index) => !!exampleText && exampleText.trim().length > 0 && highlights[index] === null,
        );

        word.exampleHighlights = highlights;
        await this.wordRepo.update(word.id, {
          examples: word.examples,
          exampleHighlights: highlights,
        });

        await Promise.all([
          this.cacheService.clear(`word:${word.id}`),
          this.cacheService.clear(`word:text:${word.text}`),
        ]);

        this.job.updatedWords += 1;
        if (hasUnresolved) {
          this.job.unresolvedWords += 1;
          this.logger.warn(
            `[AI-HIGHLIGHTS] Слово id=${word.id} (${word.text}) залишилось частково нерозмарковане навіть після перегенерації — буде повторно взято наступного запуску`,
          );
        }
      } catch (error) {
        this.job.failedWords += 1;
        this.logger.error(`[AI-HIGHLIGHTS] Не вдалося зберегти слово id=${word.id} (${word.text})`, error);
      }
    }
  }

  private async runRegenerationTasks(
    tasks: PairRegenerationTask[],
    words: Word[],
    wordHighlights: Map<number, ExampleHighlight[]>,
  ): Promise<void> {
    const wordsById = new Map(words.map((w) => [w.id, w]));

    for (let i = 0; i < tasks.length; i += PAIRS_PER_REGEN_REQUEST) {
      if (this.isOpenAiBlocked()) {
        this.logger.warn('[AI-HIGHLIGHTS] AI заблоковано через квоту — перегенерацію пропущено для решти пар');
        break;
      }

      const batch = tasks.slice(i, i + PAIRS_PER_REGEN_REQUEST);
      let results: PairRegenerationResultItem[] | null = null;

      try {
        results = await this.callAiForRegeneration(batch);
      } catch (error: any) {
        this.markQuotaExhausted(error);
        this.logger.error('[AI-HIGHLIGHTS] AI regeneration batch call failed', error);
      }

      const resultsByKey = new Map((results || []).map((r) => [r.key, r]));

      for (const task of batch) {
        const result = resultsByKey.get(task.key);
        const word = wordsById.get(task.wordId);
        if (!word) continue;

        const highlights = wordHighlights.get(task.wordId);
        if (!highlights) continue;

        if (!result) continue;

        if (result.en && word.examples) {
          word.examples[task.enIndex] = result.en;
          const literalEn = this.tryLiteralMatch(result.en, task.headword);
          const located = literalEn ?? (result.enMatch ? this.locateSubstring(result.en, result.enMatch) : null);
          highlights[task.enIndex] = located;
          if (located) this.job.regeneratedPairs += 0.5;
        }

        if (result.ua && word.examples) {
          word.examples[task.uaIndex] = result.ua;
          const literalUa = this.tryLiteralMatch(result.ua, task.translation);
          const located = literalUa ?? (result.uaMatch ? this.locateSubstring(result.ua, result.uaMatch) : null);
          highlights[task.uaIndex] = located;
          if (located) this.job.regeneratedPairs += 0.5;
        }
      }

      if (i + PAIRS_PER_REGEN_REQUEST < tasks.length) {
        await this.sleep(REQUEST_DELAY_MS);
      }
    }

    this.job.regeneratedPairs = Math.round(this.job.regeneratedPairs);
  }

  private locateSubstring(source: string, needle: string): ExampleHighlight {
    if (!needle || !source) return null;

    const trimmedNeedle = needle.trim();
    if (trimmedNeedle.length === 0) return null;

    let start = source.indexOf(trimmedNeedle);

    if (start === -1) {
      const lowerSource = source.toLowerCase();
      const lowerNeedle = trimmedNeedle.toLowerCase();
      start = lowerSource.indexOf(lowerNeedle);
    }

    if (start === -1) return null;

    const end = start + trimmedNeedle.length;
    return this.expandToWordBoundaries(source, start, end);
  }

  // Розширює діапазон до повних меж слова, щоб «tulip» у «tulips» та
  // «тюльпан» у «тюльпани» підсвічувались цілком, а не лише лемою.
  private expandToWordBoundaries(source: string, start: number, end: number): ExampleHighlight {
    let s = start;
    let e = end;
    while (s > 0 && WORD_CHAR.test(source[s - 1])) s -= 1;
    while (e < source.length && WORD_CHAR.test(source[e])) e += 1;
    return { start: s, end: e };
  }

  private buildMatchPrompt(words: AiWordBatchInput[]): string {
    const wordsBlock = words
      .map((w) => {
        const examplesBlock = w.examples
          .map((ex, idx) => `    ${idx}: "${ex}"`)
          .join('\n');
        return `- id: ${w.id}\n  headword (English): "${w.text}"\n  translation (Ukrainian): "${w.translation}"\n  examples:\n${examplesBlock}`;
      })
      .join('\n\n');

    return `
You are a precise linguistic matcher for a language-learning app. Examples are given as sequential PAIRS: index 0 is an English sentence using the headword, index 1 is its Ukrainian translation using the translation word; index 2 is another English sentence, index 3 its Ukrainian translation, and so on.

For every example sentence, find the EXACT substring (verbatim, preserving original casing and spacing) that represents an inflected/conjugated/declined form of the headword (for English sentences, indices 0, 2, 4, ...) or of the translation (for Ukrainian sentences, indices 1, 3, 5, ...).

Rules:
1. The returned substring MUST appear character-for-character inside the given sentence (copy-paste exact match), including correct casing.
2. Account for grammatical variation: plurals, verb conjugations, past tense, Ukrainian case declensions (наприклад "піца" → "піцу", "піци", "піцою" тощо), gender agreement, etc. — match whatever form of the word actually appears in that specific sentence.
3. Be thorough: actively search for declined/conjugated forms, do not only check for the exact dictionary form. Ukrainian nouns change endings by case — check all six cases and both numbers.
4. If genuinely no form of the word appears in a given sentence, return null for that index. Do not force a match to an unrelated word.
5. If the headword or translation consists of multiple words (a phrase/idiom/fixed expression), match the ENTIRE phrase as it appears in the sentence (including any grammatical variation), not just a single word from within it. Only return a shorter fragment if the full phrase truly cannot be located as a contiguous or near-contiguous span.
6. Match the SHORTEST span that represents just the word/phrase itself — do not include surrounding words.
7. Output ONLY a raw JSON object, no markdown, no explanation.

Output JSON shape:
{
  "results": [
    { "id": <word id>, "matches": [<substring or null>, <substring or null>, ...] }
  ]
}

The "matches" array for each word MUST have the same length as that word's "examples" array, in the same order.

Words to process:

${wordsBlock}
`;
  }

  private async callAiForMatchBatch(words: AiWordBatchInput[]): Promise<AiWordBatchResultItem[]> {
    const prompt = this.buildMatchPrompt(words);

    const res = await this.openai.chat.completions.create(
      {
        model: MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are an API that returns only JSON objects. Never include markdown or explanations.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      },
      { timeout: 60000 },
    );

    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error('Порожня відповідь від AI (matching)');

    const parsed = JSON.parse(content);
    if (!parsed || !Array.isArray(parsed.results)) {
      throw new Error('Некоректна структура відповіді AI (matching)');
    }

    return parsed.results
      .filter((r: any) => typeof r?.id === 'number' && Array.isArray(r?.matches))
      .map((r: any) => ({
        id: r.id,
        matches: r.matches.map((m: unknown) => (typeof m === 'string' ? m : null)),
      }));
  }

  private buildRegenerationPrompt(tasks: PairRegenerationTask[]): string {
    const tasksBlock = tasks
      .map((t) => {
        return `- key: "${t.key}"\n  headword (English): "${t.headword}"\n  translation (Ukrainian): "${t.translation}"\n  CEFR level: "${t.level || 'A1'}"\n  current English sentence: "${t.currentEn}"\n  current Ukrainian sentence: "${t.currentUa}"`;
      })
      .join('\n\n');

    return `
You are rewriting example sentence pairs for a language-learning flashcard app. Each pair consists of an English sentence using the headword and its Ukrainian translation using the translation word.

For every task below, produce a NEW natural-sounding sentence pair at the given CEFR level where:
1. The English sentence MUST contain a verbatim, exact-copy inflected/conjugated form of the headword (plural, tense, etc. as grammatically natural). If the headword is a multi-word phrase, the sentence MUST contain the ENTIRE phrase verbatim (or with natural grammatical variation), not just one word from it.
2. The Ukrainian sentence MUST be a natural translation of the English sentence AND MUST contain a verbatim, exact-copy declined form of the translation word (correct case, number, gender as grammatically required by the sentence). If the translation is a multi-word phrase, the sentence MUST contain the ENTIRE phrase verbatim (or with natural grammatical variation).
3. Keep sentences short, simple, and appropriate for the given CEFR level.
4. You MUST also return the exact substring you used for each sentence (enMatch for the English sentence, uaMatch for the Ukrainian sentence) — these substrings MUST appear character-for-character inside the sentence you return.
5. If it is genuinely impossible to include a form of the word in one of the two languages, return null for that language's fields (en/ua and its match), but still try your best — this should be extremely rare.
6. Output ONLY a raw JSON object, no markdown, no explanation.

Output JSON shape:
{
  "results": [
    { "key": "<task key>", "en": "<new English sentence or null>", "ua": "<new Ukrainian sentence or null>", "enMatch": "<exact substring or null>", "uaMatch": "<exact substring or null>" }
  ]
}

Tasks:

${tasksBlock}
`;
  }

  private async callAiForRegeneration(
    tasks: PairRegenerationTask[],
  ): Promise<PairRegenerationResultItem[]> {
    const prompt = this.buildRegenerationPrompt(tasks);

    const res = await this.openai.chat.completions.create(
      {
        model: MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are an API that returns only JSON objects. Never include markdown or explanations.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      },
      { timeout: 60000 },
    );

    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error('Порожня відповідь від AI (regeneration)');

    const parsed = JSON.parse(content);
    if (!parsed || !Array.isArray(parsed.results)) {
      throw new Error('Некоректна структура відповіді AI (regeneration)');
    }

    return parsed.results
      .filter((r: any) => typeof r?.key === 'string')
      .map((r: any) => ({
        key: r.key,
        en: typeof r.en === 'string' ? r.en : '',
        ua: typeof r.ua === 'string' ? r.ua : '',
        enMatch: typeof r.enMatch === 'string' ? r.enMatch : null,
        uaMatch: typeof r.uaMatch === 'string' ? r.uaMatch : null,
      }));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}