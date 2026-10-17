import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { ReaderPage } from '../../../types/books';
import { BackBookMeta } from './useBookManager';

interface UseBookDataParams {
  bookId: number;
  currentBook: BackBookMeta | null;
  isLoading: boolean;
  bookNotFound: boolean;
  fetchBookDetails: (bookId: number) => void;
  onNotFound: () => void;
  isFocused: boolean;
}

interface UseBookDataResult {
  chapterPages: ReaderPage[];
  totalChapters: number;
  chapterIdByIndex: number[];
}

const isValidId = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

function addAppStateChangeListener(
  handler: (state: AppStateStatus) => void
): { remove: () => void } {
  const subscription: any = AppState.addEventListener('change', handler);
  if (subscription && typeof subscription.remove === 'function') return subscription;
  return {
    remove: () => {
      const legacyRemove = (AppState as any).removeEventListener;
      if (typeof legacyRemove === 'function') legacyRemove('change', handler);
    },
  };
}

export function useBookData({
  bookId,
  currentBook,
  isLoading,
  bookNotFound,
  fetchBookDetails,
  onNotFound,
  isFocused,
}: UseBookDataParams): UseBookDataResult {
  useEffect(() => {
    if (!isValidId(bookId)) return;
    fetchBookDetails(bookId);
  }, [bookId, fetchBookDetails]);

  const onNotFoundRef = useRef(onNotFound);
  useEffect(() => { onNotFoundRef.current = onNotFound; }, [onNotFound]);

  const notFoundFiredForRef = useRef<number | null>(null);
  useEffect(() => { notFoundFiredForRef.current = null; }, [bookId]);

  useEffect(() => {
    if (!bookNotFound) return;
    if (notFoundFiredForRef.current === bookId) return;
    notFoundFiredForRef.current = bookId;
    onNotFoundRef.current();
  }, [bookNotFound, bookId]);

  const latestStateRef = useRef({ currentBook, bookNotFound, isLoading, bookId, fetchBookDetails, isFocused });
  latestStateRef.current = { currentBook, bookNotFound, isLoading, bookId, fetchBookDetails, isFocused };

  useEffect(() => {
    const subscription = addAppStateChangeListener((nextState: AppStateStatus) => {
      if (nextState !== 'active') return;
      const state = latestStateRef.current;
      if (!state.isFocused) return;
      if (!isValidId(state.bookId)) return;
      if (!state.currentBook && !state.bookNotFound && !state.isLoading) {
        state.fetchBookDetails(state.bookId);
      }
    });
    return () => subscription.remove();
  }, []);

  const lastNonEmptyResultRef = useRef<{ chapterPages: ReaderPage[]; chapterIdByIndex: number[] } | null>(null);
  const lastNonEmptyBookIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (lastNonEmptyBookIdRef.current !== bookId) {
      lastNonEmptyBookIdRef.current = bookId;
      lastNonEmptyResultRef.current = null;
    }
  }, [bookId]);

  const { chapterPages, chapterIdByIndex } = useMemo(() => {
    if (!currentBook?.chapters || !Array.isArray(currentBook.chapters) || currentBook.chapters.length === 0) {
      if (lastNonEmptyBookIdRef.current === bookId && lastNonEmptyResultRef.current) {
        return lastNonEmptyResultRef.current;
      }
      return { chapterPages: [] as ReaderPage[], chapterIdByIndex: [] as number[] };
    }

    const sortedChapters = currentBook.chapters
      .slice()
      .sort((a, b) => a.order - b.order);

    const pages: ReaderPage[] = new Array(sortedChapters.length);
    const ids: number[] = new Array(sortedChapters.length);

    for (let index = 0; index < sortedChapters.length; index++) {
      const chapter = sortedChapters[index];

      const pageId = isValidId(chapter.firstPageId)
        ? chapter.firstPageId
        : isValidId(chapter.id)
          ? chapter.id
          : bookId * 10000 + index;

      pages[index] = {
        id: pageId,
        pageNumber: chapter.order || 1,
        content: '',
        title: '',
        chapterTitle: chapter.title || '',
        bookTitle: currentBook?.title || '',
        imageUrl: chapter.imageUrl || null,
        boldIndices: [],
      };

      ids[index] = chapter.id;
    }

    const result = { chapterPages: pages, chapterIdByIndex: ids };
    lastNonEmptyBookIdRef.current = bookId;
    lastNonEmptyResultRef.current = result;
    return result;
  }, [currentBook, bookId]);

  return { chapterPages, totalChapters: chapterPages.length, chapterIdByIndex };
}
