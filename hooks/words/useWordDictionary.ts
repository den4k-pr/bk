import { useState, useEffect, useRef, useCallback } from 'react';
import { useDispatch } from 'react-redux';
import { fetchWordsByQuery } from '../../services/dictionaryApi';
import { addSimpleWord } from '../../services/wordService';
import { triggerRefresh } from '../../features/wordSlice';
import { sanitizeSearchQuery } from '../../utils/sanitizeSearchQuery';
import {
  readThroughCacheWithSource,
  writeThroughCache,
  invalidateDictionaryListCache,
} from '../../services/dictionaryCache';

const LOOKUP_MEMORY_TTL_MS = 30000;
const LOOKUP_PERSIST_TTL_MS = 180000;

function buildLookupCacheKey(word: string): string {
  return `dictionary:lookup:${word}`;
}

export const useWordDictionary = (wordText: string, visible: boolean) => {
  const dispatch = useDispatch();
  const [foundWord, setFoundWord] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);

  const isMountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      abortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const sanitizedText = sanitizeSearchQuery(wordText).value;

    if (!visible || !sanitizedText) {
      return;
    }

    const fetchWord = async () => {
      const cacheKey = buildLookupCacheKey(sanitizedText);
      const cached = await readThroughCacheWithSource<any[]>(cacheKey);

      if (cached && isMountedRef.current) {
        setFoundWord(cached.value?.[0] || null);
        if (cached.source === 'memory') {
          return;
        }
      }

      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setLoading(true);

      try {
        const res = await fetchWordsByQuery(sanitizedText, controller.signal);
        if (!isMountedRef.current) return;

        setFoundWord(res?.[0] || null);
        await writeThroughCache(cacheKey, res, LOOKUP_MEMORY_TTL_MS, LOOKUP_PERSIST_TTL_MS);
      } catch (err: any) {
        if (err?.name === 'CanceledError' || err?.name === 'AbortError') return;
        console.error('Error searching word:', err);
        if (isMountedRef.current) setFoundWord(null);
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
    };

    fetchWord();
  }, [wordText, visible]);

  const addWord = useCallback(async () => {
    const sanitizedText = sanitizeSearchQuery(wordText).value;
    if (!sanitizedText || adding || foundWord?.isAdded) return;

    setAdding(true);

    try {
      // id знайденого запису: у слова може бути кілька значень (омоніми).
      await addSimpleWord(sanitizedText, undefined, foundWord?.word?.id);

      if (isMountedRef.current) {
        setFoundWord((prev: any) =>
          prev ? { ...prev, isAdded: true } : { word: { text: sanitizedText }, isAdded: true },
        );
      }

      invalidateDictionaryListCache();
      dispatch(triggerRefresh());
    } catch (err) {
      console.error('Error adding word:', err);
    } finally {
      if (isMountedRef.current) setAdding(false);
    }
  }, [wordText, adding, foundWord, dispatch]);

  return { foundWord, loading, adding, addWord };
};