import { useCallback, useEffect, useRef } from "react";
import { getSubtitleById } from "../../services/subtitleService";
import type { SubtitleType } from "../../types/subtitles";

export const useVideoPlayer = (video: any) => {
  const videoRef = useRef<any>(null);
  const currentTimeRef = useRef(0);
  const subtitlesRef = useRef<SubtitleType | null>(null);
  const currentSubtitleIndexRef = useRef(0);

  const handleProgress = useCallback((data: { currentTime: number }) => {
    currentTimeRef.current = data.currentTime;

    if (!subtitlesRef.current?.startSeconds) return;

    const idx = subtitlesRef.current.startSeconds.findIndex(
      (start: any, i: any) => data.currentTime >= start && data.currentTime < subtitlesRef.current!.endSeconds[i]
    );

    if (idx !== -1 && idx !== currentSubtitleIndexRef.current) {
      currentSubtitleIndexRef.current = idx; // оновлюємо ref без ререндеру
    }
  }, []);

  const handleLoad = useCallback(() => {}, []);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const res = await getSubtitleById(video.id);
        if (mounted && res?.data?.length) {
          const startSeconds = res.data.map((item: any) => {
            const [m, s] = item.start.split(":").map(Number);
            return m * 60 + s;
          });
          const endSeconds = startSeconds.slice(1).concat([Infinity]);

          subtitlesRef.current = { ...res, startSeconds, endSeconds };
        }
      } catch (err) {
        console.warn("[useVideoPlayer] getSubtitleById failed", err);
      }
    })();

    return () => { mounted = false; };
  }, [video.id]);

  return { videoRef, currentTimeRef, subtitlesRef, currentSubtitleIndexRef, handleLoad, handleProgress };
};
