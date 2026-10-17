import AsyncStorage from '@react-native-async-storage/async-storage';
import { SCREEN_WIDTH } from '../BookReader.constants';
import { CYRILLIC_TEST } from './page.constants';

export interface CalibrationEntry {
  sumRatio: number;
  count: number;
}

const HEIGHT_CALIBRATION_STORAGE_PREFIX = '@reader_height_calibration_';
const HEIGHT_CALIBRATION_SAMPLE_CAP = 300;
const CALIBRATION_PERSIST_DEBOUNCE_MS = 5000;

const heightCalibrationMemoryCache = new Map<number, CalibrationEntry>();
const calibrationDiskLoadAttempted = new Set<number>();
const calibrationPersistTimers = new Map<number, ReturnType<typeof setTimeout>>();

function getFontSizeBucket(fontSize: number): number {
  return Math.round(fontSize);
}

export function addCalibrationSample(entry: CalibrationEntry, ratio: number, cap: number): void {
  if (entry.count >= cap) {
    const average = entry.sumRatio / entry.count;
    entry.sumRatio = average * (cap - 1) + ratio;
    entry.count = cap;
  } else {
    entry.sumRatio += ratio;
    entry.count += 1;
  }
}

export function getSeedCalibration(fontSize: number): CalibrationEntry {
  const bucket = getFontSizeBucket(fontSize);
  const entry = heightCalibrationMemoryCache.get(bucket);
  return entry ? { sumRatio: entry.sumRatio, count: entry.count } : { sumRatio: 0, count: 0 };
}

function scheduleCalibrationPersist(fontSizeBucket: number): void {
  if (calibrationPersistTimers.has(fontSizeBucket)) return;

  const timer = setTimeout(() => {
    calibrationPersistTimers.delete(fontSizeBucket);
    const entry = heightCalibrationMemoryCache.get(fontSizeBucket);
    if (!entry || entry.count === 0) return;

    AsyncStorage.setItem(
      `${HEIGHT_CALIBRATION_STORAGE_PREFIX}${fontSizeBucket}`,
      JSON.stringify(entry),
    ).catch(() => {});
  }, CALIBRATION_PERSIST_DEBOUNCE_MS);

  calibrationPersistTimers.set(fontSizeBucket, timer);
}

export function commitCalibrationSample(fontSize: number, ratio: number): void {
  const bucket = getFontSizeBucket(fontSize);
  let entry = heightCalibrationMemoryCache.get(bucket);
  if (!entry) {
    entry = { sumRatio: 0, count: 0 };
    heightCalibrationMemoryCache.set(bucket, entry);
  }
  addCalibrationSample(entry, ratio, HEIGHT_CALIBRATION_SAMPLE_CAP);
  scheduleCalibrationPersist(bucket);
}

export async function preloadHeightCalibration(fontSize: number): Promise<void> {
  const bucket = getFontSizeBucket(fontSize);
  if (calibrationDiskLoadAttempted.has(bucket)) return;
  calibrationDiskLoadAttempted.add(bucket);

  if (heightCalibrationMemoryCache.has(bucket)) return;

  try {
    const raw = await AsyncStorage.getItem(`${HEIGHT_CALIBRATION_STORAGE_PREFIX}${bucket}`);
    if (!raw) return;

    const parsed = JSON.parse(raw) as CalibrationEntry;
    if (
      parsed &&
      Number.isFinite(parsed.sumRatio) &&
      Number.isFinite(parsed.count) &&
      parsed.count > 0
    ) {
      heightCalibrationMemoryCache.set(bucket, { sumRatio: parsed.sumRatio, count: parsed.count });
    }
  } catch (error) {
    return;
  }
}

export function computeRawEstimateHeight(chunks: string[], fontSize: number, width: number): number {
  const text = chunks.join('');
  const charCount = text.length;
  const avgCharWidth = fontSize * (CYRILLIC_TEST.test(text) ? 0.56 : 0.5);
  const usableWidth = Math.max((width > 0 ? width : SCREEN_WIDTH) - 8, 50);
  const charsPerLine = Math.max(8, Math.floor(usableWidth / avgCharWidth));
  const estimatedLines = Math.max(1, Math.ceil(charCount / charsPerLine));
  return estimatedLines * (fontSize * 1.6);
}
