import { getAdvancedCourseById } from "../services/advancedCourseService";
import { CourseData } from "../types/courseNavigate";
import { useState, useEffect, useRef } from "react";


// Обмежений кеш структур курсів (LRU-подібний): щоб за довгу сесію в пам'яті
// не накопичувались усі колись відкриті курси.
const COURSE_CACHE_LIMIT = 20;
const courseCache = new Map<number, CourseData>();

const cacheGet = (id: number): CourseData | undefined => courseCache.get(id);

const cacheSet = (id: number, data: CourseData): void => {
  courseCache.delete(id); // перевставляємо, щоб оновити «свіжість»
  courseCache.set(id, data);
  if (courseCache.size > COURSE_CACHE_LIMIT) {
    const oldestKey = courseCache.keys().next().value;
    if (oldestKey !== undefined) courseCache.delete(oldestKey);
  }
};

export const useCourseNavigate = (courseId: number) => {
  const [courseData, setCourseData] = useState<CourseData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isActiveRef = useRef(true);

  useEffect(() => {
    isActiveRef.current = true;

    if (!courseId) {
      setIsLoading(false);
      return () => {
        isActiveRef.current = false;
      };
    }

    const fetchCourse = async () => {
      const cachedData = cacheGet(courseId);
      const hadCachedData = !!cachedData;

      if (hadCachedData) {
        console.log(`✅ Course structure for ID ${courseId} shown from CACHE (instant), revalidating in background...`);
        setCourseData(cachedData);
        setIsLoading(false);
      } else {
        setIsLoading(true);
      }

      // Мережевий запит виконується ЗАВЖДИ, незалежно від того, чи був
      // кеш — кеш тільки прискорює перший показ, а не замінює звірку
      // з сервером.
      try {
        console.log(`⬇️ Fetching course structure for ID ${courseId} from API...`);
        const freshData = await getAdvancedCourseById(courseId);

        if (!isActiveRef.current) return;

        if (freshData) {
          cacheSet(courseId, freshData);
          setCourseData(freshData);
          setError(null);
        } else if (!hadCachedData) {
          setCourseData(null);
        }
      } catch (err) {
        if (!isActiveRef.current) return;

        console.error(err);
        if (!hadCachedData) {
          // Кешу не було взагалі — це справжня помилка завантаження,
          // показуємо її користувачу.
          setError("Не вдалося завантажити курс.");
          setCourseData(null);
        } else {
          // Кеш уже показано — мережева помилка тут некритична,
          // просто лишаємо те, що вже відображено.
          console.warn(`⚠️ Не вдалося оновити структуру курсу ${courseId} з мережі, лишаємо кешовану версію.`);
        }
      } finally {
        if (isActiveRef.current) setIsLoading(false);
      }
    };

    fetchCourse();

    return () => {
      isActiveRef.current = false;
    };
  }, [courseId]);

  return { courseData, isLoading, error };
};