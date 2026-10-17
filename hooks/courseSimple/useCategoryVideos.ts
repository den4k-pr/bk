import { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../../store';
import { getCategoryById } from '../../services/simpleCourseService';
import { VideoItem } from '../../types/courseVideo';

// Додаємо новий інтерфейс для згрупованих даних
export interface GroupedVideoSection {
  sectionName: string;
  videos: VideoItem[];
}

export const useCategoryVideos = (categoryId: number) => {
  // Змінюємо стейт на збереження згрупованих секцій
  const [groupedSections, setGroupedSections] = useState<GroupedVideoSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const progressRecords = useSelector(
    (state: RootState) => state.progressSimple.progressRecords
  );

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const category = await getCategoryById(categoryId);

        if (!category || !category.videos || category.videos.length === 0) {
          setGroupedSections([]);
          return;
        }

        // 1. Проходимо по відео і додаємо статуси прогресу
        const preparedVideos: VideoItem[] = category.videos.map((v: any) => {
          const localProgress = progressRecords.find((p: any) => p.videoId === String(v.id));
          const currentStatus = localProgress ? localProgress.status : (v.status || 'not_started');

          return {
            ...v,
            completed: currentStatus === 'completed',
            notFinished: currentStatus === 'mid' || currentStatus === 'in_progress',
            status: currentStatus
          };
        });

        // 2. Групуємо відео за полем sectionName
        const grouped = preparedVideos.reduce((acc: Record<string, VideoItem[]>, video: any) => {
          const section = video.sectionName || 'Загальні';
          if (!acc[section]) {
            acc[section] = [];
          }
          acc[section].push(video);
          return acc;
        }, {});

        // 3. Перетворюємо об'єкт назад у масив для зручного мапінгу в JSX
        const sectionsArray = Object.keys(grouped).map(key => ({
          sectionName: key,
          videos: grouped[key]
        }));

        setGroupedSections(sectionsArray);
      } catch (err: any) {
        console.error(err);
        setError('Failed to load data.');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [categoryId, progressRecords]);

  // Повертаємо згруповані секції замість плаского масиву
  return { groupedSections, loading, error };
};