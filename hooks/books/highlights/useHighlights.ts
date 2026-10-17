import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHighlight } from '../../../types/books';

interface UseHighlightsParams {
  bookId: number;
  fetchAllHighlightsForBook: (bookId: number) => Promise<BackHighlight[]>;
  addHighlight: (
    pageId: number,
    text: string,
    color: string,
    startIdx: number,
    endIdx: number
  ) => Promise<BackHighlight | undefined>;
  // 🟢 ЗМІНЕНО (сумісна зміна контракту): тепер повертає Promise<boolean>
  // (успіх/невдача) замість Promise<void>. Це ЄДИНА зміна контракту в
  // цьому файлі, і вона зроблена САМЕ для того, щоб мати можливість
  // відкотити оптимістичне видалення, якщо запит на бекенд провалився —
  // без неї відкат був фізично неможливий, бо useBookManager.removeHighlight
  // ковтав помилки мовчки. Поведінка самого видалення на бекенді НЕ
  // змінена, додано лише повернене значення успіху (див. useBookManager.ts).
  removeHighlight?: (pageId: number, startIndex: number, endIndex: number) => Promise<boolean>;
}

interface HighlightPhrase {
  text: string;
  startIdx: number;
  endIdx: number;
}

interface UseHighlightsResult {
  localHighlights: Record<number, BackHighlight[]>;
  handleSaveHighlight: (pageId: number, phrase: HighlightPhrase, color: string) => Promise<void>;
  handleRemoveHighlight: (pageId: number, startIndex: number, endIndex: number) => Promise<void>;
}

/** Owns loading all highlights for a book and optimistically saving/removing them. */
export function useHighlights({
  bookId,
  fetchAllHighlightsForBook,
  addHighlight,
  removeHighlight,
}: UseHighlightsParams): UseHighlightsResult {
  const [localHighlights, setLocalHighlights] = useState<Record<number, BackHighlight[]>>({});

  // 🟢 НОВЕ: дзеркало localHighlights у ref. Потрібне, щоб і
  // handleSaveHighlight, і handleRemoveHighlight могли синхронно взяти
  // "знімок" стану ДО оптимістичної зміни (щоб було до чого відкочуватись),
  // а також щоб коректно об'єднувати кілька швидких послідовних дій без
  // залежності від того, чи React вже встиг перерендерити компонент.
  const localHighlightsRef = useRef<Record<number, BackHighlight[]>>({});

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const applyLocalHighlights = useCallback((next: Record<number, BackHighlight[]>) => {
    localHighlightsRef.current = next;
    if (isMountedRef.current) {
      setLocalHighlights(next);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadHighlights = async (): Promise<void> => {
      try {
        const allHighlights = await fetchAllHighlightsForBook(bookId);

        if (!isMounted) return;

        if (Array.isArray(allHighlights)) {
          const groupedHighlights = allHighlights.reduce((acc, h) => {
            // @ts-ignore
            const pId = h?.page?.id || h?.pageId;
            if (!pId) return acc;

            if (!acc[pId]) acc[pId] = [];
            acc[pId].push(h);
            return acc;
          }, {} as Record<number, BackHighlight[]>);

          applyLocalHighlights(groupedHighlights);
        } else {
          applyLocalHighlights({});
        }
      } catch (error) {
        console.error('Помилка при завантаженні всіх хайлайтів:', error);
      }
    };

    loadHighlights();

    return () => {
      isMounted = false;
    };
  }, [bookId, fetchAllHighlightsForBook, applyLocalHighlights]);

  const handleSaveHighlight = useCallback(
    async (pageId: number, phrase: HighlightPhrase, color: string): Promise<void> => {
      const { text, startIdx, endIdx } = phrase;

      // 🟢 НОВЕ: знімок стану ДО оптимістичного апдейту — потрібен лише
      // для відкату, якщо запит на сервер провалиться.
      const snapshotForPage = localHighlightsRef.current[pageId];

      const newHighlight: BackHighlight = {
        id: Date.now(),
        word: text,
        color,
        startIndex: startIdx,
        endIndex: endIdx,
      };

      const existing = Array.isArray(localHighlightsRef.current[pageId])
        ? localHighlightsRef.current[pageId]
        : [];
      const filtered = existing.filter(
        (h) => !(startIdx <= h.endIndex && endIdx >= h.startIndex)
      );
      applyLocalHighlights({
        ...localHighlightsRef.current,
        [pageId]: [...filtered, newHighlight],
      });

      // 🔴 ФІКС (узгодженість даних — реальний баг): раніше результат
      // addHighlight ніяк не перевірявся. Якщо запит на бекенд провалявся
      // (мережа, 500, rate-limit 429 тощо), локальний "оптимістичний"
      // хайлайт лишався видимим у читалці НАЗАВЖДИ в межах поточної
      // сесії, хоча на сервері його не існувало. Після перезапуску
      // застосунку (localHighlights заново тягнеться через
      // fetchAllHighlightsForBook з сервера) такий хайлайт безслідно
      // зникав — типова скарга користувача "у мене зникло виділення",
      // хоча одразу після дії воно виглядало збереженим.
      //
      // Тепер: якщо addHighlight повернув undefined (ознака невдачі —
      // контракт useBookManager.addHighlight НЕ змінено, він і раніше
      // повертав undefined при помилці) — відкочуємо рівно ту сторінку
      // до знімку, зробленого до оптимістичної зміни.
      const saved = await addHighlight(pageId, text, color, startIdx, endIdx);

      if (!saved) {
        applyLocalHighlights({
          ...localHighlightsRef.current,
          [pageId]: snapshotForPage ?? [],
        });
      }
    },
    [addHighlight, applyLocalHighlights]
  );

  const handleRemoveHighlight = useCallback(
    async (pageId: number, startIndex: number, endIndex: number): Promise<void> => {
      const snapshotForPage = localHighlightsRef.current[pageId];

      const existing = Array.isArray(localHighlightsRef.current[pageId])
        ? localHighlightsRef.current[pageId]
        : [];
      const filtered = existing.filter(
        (h) => !(startIndex <= h.endIndex && endIndex >= h.startIndex)
      );
      applyLocalHighlights({
        ...localHighlightsRef.current,
        [pageId]: filtered,
      });

      if (removeHighlight) {
        // 🔴 ФІКС: так само, як і для збереження — якщо видалення на
        // бекенді не вдалось, повертаємо назад те, що щойно приховали
        // локально, замість того, щоб мовчки лишати розбіжність
        // клієнт/сервер (яка б виявилась лише після перезапуску
        // застосунку у вигляді "хайлайт знову з'явився нізвідки").
        const success = await removeHighlight(pageId, startIndex, endIndex);
        if (!success) {
          applyLocalHighlights({
            ...localHighlightsRef.current,
            [pageId]: snapshotForPage ?? [],
          });
        }
      }
    },
    [removeHighlight, applyLocalHighlights]
  );

  return { localHighlights, handleSaveHighlight, handleRemoveHighlight };
}
