// useGlobalWordSearch.ts (сумісна версія)

import { useState, useEffect, useRef } from "react";
import { searchGlobalWords } from "../../services/wordService";
import { FoundWordResult } from "../../types/words";

export const useGlobalWordSearch = (query: string) => {
  const [results, setResults] = useState<FoundWordResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isError, setIsError] = useState(false);

  // ✅ Використовуємо useRef, щоб відстежувати останній актуальний запит
  const latestQueryRef = useRef(query);
  latestQueryRef.current = query;

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    const fetchResults = async () => {
      setIsLoading(true);
      setIsError(false);
      try {
        const fetched = await searchGlobalWords(query.trim());
        
        // ✅ Оновлюємо результати, тільки якщо відповідь прийшла для останнього запиту.
        // Це запобігає тому, що стара, повільна відповідь перезапише нову.
        if (latestQueryRef.current === query) {
          setResults(fetched);
        }

      } catch (err) {
        console.error("Помилка пошуку глобальних слів:", err);
        if (latestQueryRef.current === query) {
            setIsError(true);
            setResults([]);
        }
      } finally {
        if (latestQueryRef.current === query) {
            setIsLoading(false);
        }
      }
    };

    fetchResults();

  }, [query]); // Ефект залежить від debounced-запиту

  return { results, isLoading, isError };
};