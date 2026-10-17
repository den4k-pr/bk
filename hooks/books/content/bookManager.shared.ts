import type { PagePhraseOverrides } from '../../../components/Books/BookReader/Phrases/phraseOverrides';
import {
  BackBookmark,
} from '../../../types/books';

export const HARD_TIMEOUT_GRACE_MS = 3000;

export function withHardTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error('Request hard timeout exceeded'), { name: 'HardTimeoutError' }));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export interface BackChapterMeta {
  id: number;
  title: string;
  imageUrl: string | null;
  order: number;
  pagesCount: number;
  firstPageId: number | null;
}

export interface BackBookMeta {
  id: number;
  title: string;
  level: string;
  coverImage: string | null;
  detailsImage: string | null;
  totalPagesCount: number;
  contentVersion: number;
  chapters: BackChapterMeta[];
  progressPercentage?: number;
  lastReadPageId?: number | null;
}

export interface ReaderChapterContent {
  id: number;
  chapterId: number;
  pageNumber: number;
  content: string;
  title: string;
  chapterTitle: string;
  bookTitle: string;
  imageUrl: string | null;
  boldIndices: number[];
  phraseOverrides?: PagePhraseOverrides | null;
}

export interface ApiErrorResponse {
  response?: {
    status?: number;
    data?: {
      message?: string;
    };
  };
  message?: string;
  name?: string;
}

export const getErrorMessage = (err: unknown, fallback: string): string => {
  const apiError = err as ApiErrorResponse;
  return apiError?.response?.data?.message || apiError?.message || fallback;
};

export const isAbortError = (err: unknown): boolean => {
  const apiError = err as ApiErrorResponse;
  return apiError?.name === 'AbortError' || apiError?.name === 'CanceledError';
};

export const isNotFoundError = (err: unknown): boolean => {
  const apiError = err as ApiErrorResponse;
  return apiError?.response?.status === 404;
};

export const isValidId = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

// Сервер (старі версії) віддавав закладки без ORDER BY — Postgres повертав їх
// у довільному порядку, і нова закладка «телепортувалась» у середину списку.
// Сортуємо за id (порядок створення), щоб список був стабільним.
export const sortBookmarks = (data: unknown): BackBookmark[] =>
  Array.isArray(data) ? [...(data as BackBookmark[])].sort((a, b) => (a?.id ?? 0) - (b?.id ?? 0)) : [];

export const hasAbortController = typeof AbortController !== 'undefined';

export const createTimeoutController = (ms: number): { controller: AbortController; clear: () => void } => {
  if (!hasAbortController) {
    const stub = { signal: undefined, abort: () => {} } as unknown as AbortController;
    return { controller: stub, clear: () => {} };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return { controller, clear: () => clearTimeout(timeoutId) };
};
