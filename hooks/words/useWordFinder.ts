// src/hooks/useWordFinder.ts

import { useState, useRef, useCallback } from 'react';
import { findExactWord } from '../../services/wordService'; // Припустимо, що тип імпортується
import { FoundWordData } from '../../components/Subtitles/InfoOfWordSubtitle';
import { ExactWordSearchResult } from '../../types/words';

const DEBOUNCE_DELAY = 400;

export const useWordFinder = () => {
    const [isLoading, setIsLoading] = useState(false);
    const [data, setData] = useState<FoundWordData | null>(null);
    const [isVisible, setIsVisible] = useState(false);

    const debounceTimeout = useRef<any>(null); // ✅ Краще типізувати як NodeJS.Timeout

    const findWord = useCallback((wordText: string) => {
        const cleanWord = wordText.replace(/[.,!?:]/g, '').toLowerCase();
        if (!cleanWord) return;

        setIsVisible(true);
        setIsLoading(true);
        setData(null);

        if (debounceTimeout.current) {
            clearTimeout(debounceTimeout.current);
        }

        debounceTimeout.current = setTimeout(async () => {
            try {
                // Типізуємо результат, щоб було зрозуміліше
                const result: ExactWordSearchResult = await findExactWord(cleanWord);

                // ✅ ОСНОВНЕ ВИПРАВЛЕННЯ:
                // Перевіряємо, що і результат, і саме слово в ньому існують
                if (result && result.word) {
                    // Всередині цього блоку TypeScript впевнений, що result.word не є null,
                    // і тому `result` відповідає типу `FoundWordData`.
                    setData(result as FoundWordData);
                } else {
                    // Якщо слово не знайдено, встановлюємо дані в null
                    setData(null);
                }

            } catch (e) {
                console.error("Error fetching word data in useWordFinder:", e);
                setData(null);
            } finally {
                setIsLoading(false);
            }
        }, DEBOUNCE_DELAY);
    }, []);

    return {
        isSubtitleLoading: isLoading,
        subtitleData: data,
        isSubtitleVisible: isVisible,
        setSubtitleVisible: setIsVisible,
        findWord,
    };
};