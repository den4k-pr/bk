import { useMemo, useEffect } from 'react';
import { useSelector } from 'react-redux';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CourseData, Task } from '../types/courseNavigate';
import { RootState } from '../../store';

const CACHE_PREFIX = '@course_progress:';

export const useProcentegeProgress = (course: CourseData | any) => {
  const progress = useSelector((state: RootState) => state.steps.progress);
  const pendingLearnedSteps = useSelector((state: RootState) => state.steps.pendingLearnedSteps);

  const progressPercent = useMemo(() => {
    if (!course?.tasks || !progress) {
      return 0;
    }

    let totalSteps = 0;
    let learnedSteps = 0;

    course.tasks.forEach((task: Task) => {
      totalSteps += task.steps.length;
      const taskLearned = progress.learned?.[String(task.id)] || [];
      const pendingForTask = pendingLearnedSteps
        .filter(s => s.taskId === task.id)
        .map(s => s.stepId);

      const uniqueLearned = Array.from(new Set([...taskLearned, ...pendingForTask]));
      learnedSteps += uniqueLearned.length;
    });

    if (totalSteps === 0) {
      return 0;
    }

    return Math.round((learnedSteps / totalSteps) * 100);
  }, [course?.tasks, progress, pendingLearnedSteps]);

  useEffect(() => {
    const saveProgressToCache = async () => {
      if (course?.id) {
        try {
          const userId = await AsyncStorage.getItem('userId');
          if (!userId) {
            console.warn("⚠️ Cannot save progress: userId not found in AsyncStorage");
            return;
          }

          const key = `${CACHE_PREFIX}${userId}_${course.id}`;
          await AsyncStorage.setItem(key, String(progressPercent));

          console.log("✅ Saved percent progress:", progressPercent, "for", key);
        } catch (error) {
          console.error("❌ Failed to save progress to AsyncStorage", error);
        }
      }
    };

    saveProgressToCache();
  }, [progressPercent, course?.id]);

  return progressPercent;
};

// Для читання з кешу (оновлений варіант)
export const getCachedProgress = async (userId: string, courseId: string): Promise<number> => {
  try {
    const key = `${CACHE_PREFIX}${userId}_${courseId}`;
    const cachedValue = await AsyncStorage.getItem(key);
    return cachedValue !== null ? Number(cachedValue) : 0;
  } catch (error) {

    return 0;
  }
};
