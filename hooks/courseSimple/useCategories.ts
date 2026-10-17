import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useSelector } from 'react-redux';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { RootState } from '../../../store';
import { getCategories } from '../../services/simpleCourseService';
import { CategoryWithProgress } from '../../types/courseCategories';

const CATEGORIES_STORAGE_KEY = 'categories_cache_v1';

const memoryCache: { data: CategoryWithProgress[]; hydratedFromDisk: boolean; fetchedAt: number } = {
  data: [],
  hydratedFromDisk: false,
  fetchedAt: 0,
};

// Хук живе одночасно на головній (ReturnToWork) і в курсах. Раніше кожен
// екземпляр слав свій запит; тепер — один спільний запит на всіх, а
// повторне монтування в межах FRESH_MS бере вже отримане.
const FRESH_MS = 30_000;
let sharedRequest: Promise<CategoryWithProgress[]> | null = null;

const loadCategoriesShared = (force: boolean): Promise<CategoryWithProgress[]> => {
  if (!force && memoryCache.data.length > 0 && Date.now() - memoryCache.fetchedAt < FRESH_MS) {
    return Promise.resolve(memoryCache.data);
  }
  if (!sharedRequest) {
    sharedRequest = getCategories()
      .then((data: unknown) => {
        const arr: CategoryWithProgress[] = Array.isArray(data) ? data : [];
        memoryCache.data = arr;
        memoryCache.fetchedAt = Date.now();
        persistCategories(arr);
        return arr;
      })
      .finally(() => {
        sharedRequest = null;
      });
  }
  return sharedRequest;
};

const STATUS_PRIORITY: Record<string, number> = {
  not_started: 0,
  mid: 1,
  in_progress: 1,
  completed: 2,
};

const persistCategories = (data: CategoryWithProgress[]) => {
  AsyncStorage.setItem(CATEGORIES_STORAGE_KEY, JSON.stringify(data)).catch(() => {});
};

export const useCategories = () => {
  const [categories, setCategories] = useState<CategoryWithProgress[]>(() => memoryCache.data);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(() => memoryCache.data.length === 0);

  const isFetchingRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const progressRecords = useSelector(
    (state: RootState) => state.progressSimple.progressRecords
  );

  useEffect(() => {
    if (memoryCache.data.length > 0 || memoryCache.hydratedFromDisk) return;

    let isActive = true;
    memoryCache.hydratedFromDisk = true;

    AsyncStorage.getItem(CATEGORIES_STORAGE_KEY)
      .then((json) => {
        if (!isActive || !json) return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch {
          return;
        }

        if (!Array.isArray(parsed) || parsed.length === 0) return;

        memoryCache.data = parsed as CategoryWithProgress[];

        if (isMountedRef.current && memoryCache.data.length > 0) {
          setCategories((prev) => (prev.length > 0 ? prev : (parsed as CategoryWithProgress[])));
          setIsLoading(false);
        }
      })
      .catch(() => {});

    return () => {
      isActive = false;
    };
  }, []);

  const fetchCategories = useCallback(async (force: boolean = false) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    setError(null);

    try {
      const arr = await loadCategoriesShared(force);

      if (isMountedRef.current) setCategories(arr);
    } catch (e) {
      console.error('[useCategories] fetch error:', e);
      if (isMountedRef.current && memoryCache.data.length === 0) {
        setError("Помилка з'єднання");
      }
    } finally {
      isFetchingRef.current = false;
      if (isMountedRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCategories();
  }, []);

  const categoriesWithLocalProgress = useMemo(() => {
    if (categories.length === 0) return categories;

    const statusByVideo = new Map<number, string>();
    const safeProgressRecords = Array.isArray(progressRecords) ? progressRecords : [];
    safeProgressRecords.forEach((p: any) => statusByVideo.set(Number(p.videoId), p.status));

    return categories.map((cat) => {
      const safeVideos = Array.isArray(cat.videos) ? cat.videos : [];

      const updatedVideos = safeVideos.map((v: any) => {
        const localStatus = statusByVideo.get(Number(v.id));
        const localPriority = STATUS_PRIORITY[localStatus ?? ''] ?? 0;
        const serverPriority = STATUS_PRIORITY[v.status ?? ''] ?? 0;

        const status =
          localPriority >= serverPriority
            ? localStatus ?? v.status ?? 'not_started'
            : v.status ?? 'not_started';

        return status === v.status ? v : { ...v, status };
      });

      const completedCount = updatedVideos.filter((v: any) => v.status === 'completed').length;
      const totalCount = cat.total > 0 ? cat.total : safeVideos.length;
      const progressPercentage =
        totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

      return {
        ...cat,
        videos: updatedVideos,
        completed: completedCount,
        total: totalCount,
        progress: progressPercentage,
      };
    });
  }, [categories, progressRecords]);

  return {
    categories: categoriesWithLocalProgress,
    isLoading,
    error,
    refreshCategories: () => fetchCategories(true),
    hasData: categoriesWithLocalProgress.length > 0,
  };
};