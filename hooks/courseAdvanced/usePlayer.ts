// usePlayer.ts
import { useEffect, useState } from "react";
import { WebView } from "react-native-webview";

const BAR_COUNT = 40;
const MIN_BAR_HEIGHT = 3;
const MAX_BAR_HEIGHT = 65;

export const usePlayer = (webViewRef: any) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(1);
  const [position, setPosition] = useState(0);
  const [barHeights, setBarHeights] = useState<number[]>([]);
  const [speed, setSpeed] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(1);

  const generateHeights = () =>
    Array.from({ length: BAR_COUNT }, () =>
      Math.random() * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT) + MIN_BAR_HEIGHT
    );

  useEffect(() => {
    setBarHeights(generateHeights());
  }, []);

  const togglePlay = (data?: any) => {
    if (data) {
      if (data.position !== undefined) setPosition(data.position);
      if (data.duration !== undefined) setDuration(data.duration);
      if (data.isPlaying !== undefined) setIsPlaying(data.isPlaying);
      return;
    }
    webViewRef.current?.postMessage("toggle");
  };

  const handleSeek = (index: number) => {
    if (duration <= 0) return;
    const targetSec = (index / (BAR_COUNT - 1)) * (duration / 1000);
    webViewRef.current?.postMessage(`seek:${targetSec}`);
    setPosition(targetSec * 1000);
  };

  const activeBarIndex = Math.floor((position / duration) * (BAR_COUNT - 1));

  const formatTime = (ms: number) => {
    if (!ms || isNaN(ms)) return "0:00";
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  const changePlaybackRate = (rate: number) => {
    setPlaybackRate(rate);
    webViewRef.current?.postMessage(`playbackRate:${rate}`);
  };

  const changeSpeed = () => {
    const speeds = [1, 1.5, 2];
    const currentIndex = speeds.indexOf(speed);
    const nextIndex = (currentIndex + 1) % speeds.length;
    const nextSpeed = speeds[nextIndex];
    setSpeed(nextSpeed);
    changePlaybackRate(nextSpeed);
  };

  return {
    isPlaying,
    togglePlay,
    barHeights,
    handleSeek,
    position,
    duration,
    formatTime,
    activeBarIndex,
    changeSpeed,
    speed
  };
};
