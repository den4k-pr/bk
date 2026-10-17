import { useCallback, useEffect, useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { useNavigation } from '@react-navigation/native';
import { AppDispatch, RootState } from '../../../store';
import { CategoryWithProgress, VideoItem } from '../../types/courseCategories';
import {
  clampWatchedPercent,
  mergeServerProgress,
  normalizeStatus,
  STATUS_PRIORITY,
} from '../../features/progressSimpleSlice';

export interface GroupedVideoSection {
  sectionName: string;
  videos: VideoItem[];
}

export const useCategoryVideosData = (category?: CategoryWithProgress) => {
  const navigation = useNavigation<any>();
  const dispatch = useDispatch<AppDispatch>();

  const progressRecords = useSelector(
    (state: RootState) => state.progressSimple?.progressRecords || []
  );

  const serverStatuses = useMemo(() => {
    if (!category?.videos?.length) return [];
    return category.videos
      .map((video: any) => ({
        videoId: Number(video.id),
        status: normalizeStatus(video.status),
        watchedPercent: clampWatchedPercent(video.watchedPercent),
      }))
      .filter((item) => item.status !== 'not_started' || item.watchedPercent > 0);
  }, [category?.videos]);

  useEffect(() => {
    if (serverStatuses.length === 0) return;
    dispatch(mergeServerProgress(serverStatuses));
  }, [dispatch, serverStatuses]);

  const progressMap = useMemo(() => {
    const map = new Map<number, string>();
    if (!category?.videos) return map;

    const localByVideo = new Map<number, string>();
    progressRecords.forEach((record: any) => {
      localByVideo.set(Number(record.videoId), record.status);
    });

    category.videos.forEach((video: any) => {
      const videoId = Number(video.id);
      const localStatus = localByVideo.get(videoId) ?? 'not_started';
      const serverStatus = normalizeStatus(video.status);

      const status =
        (STATUS_PRIORITY[localStatus] ?? 0) >= (STATUS_PRIORITY[serverStatus] ?? 0)
          ? localStatus
          : serverStatus;

      map.set(videoId, status);
    });

    return map;
  }, [category?.videos, progressRecords]);

  // Переглянуто відсотків для смужки на превʼю: більше з локального й серверного.
  const watchedMap = useMemo(() => {
    const map = new Map<number, number>();
    if (!category?.videos) return map;

    const localByVideo = new Map<number, number>();
    progressRecords.forEach((record: any) => {
      localByVideo.set(Number(record.videoId), clampWatchedPercent(record.watchedPercent));
    });

    category.videos.forEach((video: any) => {
      const videoId = Number(video.id);
      map.set(videoId, Math.max(localByVideo.get(videoId) ?? 0, clampWatchedPercent(video.watchedPercent)));
    });

    return map;
  }, [category?.videos, progressRecords]);

  const groupedSections = useMemo<GroupedVideoSection[]>(() => {
    if (!category?.videos) return [];

    const grouped = category.videos.reduce(
      (acc: Record<string, VideoItem[]>, video: VideoItem) => {
        const section = (video as any).sectionName || 'Загальні';
        if (!acc[section]) acc[section] = [];
        acc[section].push(video);
        return acc;
      },
      {}
    );

    return Object.keys(grouped).map((key) => ({
      sectionName: key,
      videos: grouped[key],
    }));
  }, [category?.videos]);

  const handleVideoPress = useCallback(
    (video: VideoItem) => {
      navigation.navigate('ComponentOfVideoSimple', { video });
    },
    [navigation]
  );

  return {
    groupedSections,
    videosData: category?.videos || [],
    progressMap,
    watchedMap,
    handleVideoPress,
  };
};