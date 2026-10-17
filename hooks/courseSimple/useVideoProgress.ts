import { useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import { AppDispatch, RootState } from "../../../store";
import {
  makeSelectProgressForVideo,
  commitVideoProgress,
  STATUS_PRIORITY,
  clampWatchedPercent,
} from "../../features/progressSimpleSlice";

// Відео зараховується як переглянуте після половини — або коли до кінця
// лишились лише титри/прощання (для відео, довших за хвилину). Раніше
// поріг був 70% і нічим не показувався користувачу; тепер смужка на
// превʼю наповнюється, і видно, скільки лишилось.
export const COMPLETE_THRESHOLD_PERCENT = 0.5;
export const COMPLETE_REMAINING_SECONDS = 15;
const COMPLETE_REMAINING_MIN_DURATION = 60;
export const MID_THRESHOLD_SECONDS = 10;
// Відсоток перегляду надсилається кроками, щоб не смикати сервер щосекунди.
export const WATCHED_STEP_PERCENT = 10;

type Snapshot = { priority: number; status: string | null; watched: number };

export function desiredStatusFor(currentTime: number, duration: number): string | null {
  if (!duration || duration <= 0) return null;
  const nearEnd =
    duration > COMPLETE_REMAINING_MIN_DURATION && duration - currentTime <= COMPLETE_REMAINING_SECONDS;
  if (currentTime / duration >= COMPLETE_THRESHOLD_PERCENT || nearEnd) return "completed";
  if (currentTime > MID_THRESHOLD_SECONDS) return "in_progress";
  return null;
}

export const useVideoProgress = (videoId: number, currentTime: number, duration: number) => {
  const dispatch = useDispatch<AppDispatch>();

  const selectProgressForVideo = useRef(makeSelectProgressForVideo()).current;
  const progress = useSelector((state: RootState) =>
    selectProgressForVideo(state, Number(videoId))
  );

  // Що вже надіслано (оптимістично) і що підтвердив сервер.
  const sentRef = useRef<Snapshot>({ priority: 0, status: null, watched: 0 });
  const confirmedRef = useRef<Snapshot>({ priority: 0, status: null, watched: 0 });
  // Останній стан перегляду — для фінального відправлення при виході.
  const latestRef = useRef<{ status: string | null; watched: number }>({ status: null, watched: 0 });

  useEffect(() => {
    sentRef.current = { priority: 0, status: null, watched: 0 };
    confirmedRef.current = { priority: 0, status: null, watched: 0 };
    latestRef.current = { status: null, watched: 0 };
  }, [videoId]);

  const storedStatus = progress?.status ?? "not_started";
  const storedWatched = progress?.watchedPercent ?? 0;

  useEffect(() => {
    if (!duration || duration <= 0) return;

    // Вниз: 49,5% — ще не половина (інакше смужка показала б 50% без ✓).
    const watched = clampWatchedPercent(Math.floor((currentTime / duration) * 100));
    const desired = desiredStatusFor(currentTime, duration);

    const storedPriority = STATUS_PRIORITY[storedStatus] ?? 0;
    const desiredPriority = desired ? STATUS_PRIORITY[desired] ?? 0 : 0;
    const effectiveStatus =
      desired && desiredPriority > storedPriority ? desired : storedPriority > 0 ? storedStatus : null;

    latestRef.current = {
      status: effectiveStatus,
      watched: Math.max(latestRef.current.watched, watched),
    };

    // Без статусу (перші 10 с) нічого не зберігаємо — як і раніше.
    if (!effectiveStatus) return;

    const effectivePriority = STATUS_PRIORITY[effectiveStatus] ?? 0;
    const knownPriority = Math.max(storedPriority, sentRef.current.priority);
    const knownWatched = Math.max(storedWatched, sentRef.current.watched);
    const bucket = Math.floor(watched / WATCHED_STEP_PERCENT) * WATCHED_STEP_PERCENT;

    const statusChanged = effectivePriority > knownPriority;
    const watchedStep = bucket > knownWatched;
    if (!statusChanged && !watchedStep) return;

    const watchedToSend = Math.max(bucket, knownWatched);
    const previous = sentRef.current;
    sentRef.current = { priority: Math.max(effectivePriority, knownPriority), status: effectiveStatus, watched: watchedToSend };

    dispatch(commitVideoProgress({ videoId: Number(videoId), status: effectiveStatus, watchedPercent: watchedToSend }))
      .unwrap()
      .then(() => {
        confirmedRef.current = { ...sentRef.current };
      })
      .catch(() => {
        // Повторимо на наступному кроці перегляду.
        sentRef.current = previous;
      });
  }, [dispatch, videoId, currentTime, duration, storedStatus, storedWatched]);

  // Вихід із плеєра / інше відео: точний відсоток і непідтверджений статус.
  useEffect(() => {
    return () => {
      const latest = latestRef.current;
      const confirmed = confirmedRef.current;
      if (!latest.status) return;
      const latestPriority = STATUS_PRIORITY[latest.status] ?? 0;
      if (latest.watched <= confirmed.watched && latestPriority <= confirmed.priority) return;

      dispatch(commitVideoProgress({ videoId: Number(videoId), status: latest.status, watchedPercent: latest.watched }))
        .unwrap()
        .catch(() => {});
    };
  }, [dispatch, videoId]);
};
