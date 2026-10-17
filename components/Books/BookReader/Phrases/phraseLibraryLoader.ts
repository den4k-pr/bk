import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../../../../services/api';
import { loadPhraseDictionary } from './phraseDetection';

const DICTIONARY_STORAGE_KEY = '@phrase_dictionary';
const DICTIONARY_VERSION_KEY = '@phrase_dictionary_version';

interface PhraseDictionaryVersion {
  count: number;
  updatedAt: number;
}

let isLoadedIntoMemory = false;
let inFlightLoad: Promise<void> | null = null;

async function readLocalVersion(): Promise<PhraseDictionaryVersion | null> {
  try {
    const raw = await AsyncStorage.getItem(DICTIONARY_VERSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.count === 'number' &&
      typeof parsed.updatedAt === 'number'
    ) {
      return parsed;
    }
    return null;
  } catch (error) {
    return null;
  }
}

async function writeLocalVersion(version: PhraseDictionaryVersion): Promise<void> {
  try {
    await AsyncStorage.setItem(DICTIONARY_VERSION_KEY, JSON.stringify(version));
  } catch (error) {
    return;
  }
}

async function loadFromDisk(): Promise<boolean> {
  try {
    const cached = await AsyncStorage.getItem(DICTIONARY_STORAGE_KEY);
    if (!cached) return false;
    const parsed = JSON.parse(cached);
    if (!parsed || typeof parsed !== 'object') return false;
    loadPhraseDictionary(parsed);
    isLoadedIntoMemory = true;
    return true;
  } catch (error) {
    return false;
  }
}

async function loadFromNetwork(): Promise<boolean> {
  try {
    const response = await api.get('/phrase-library/export');
    if (!response?.data) return false;
    loadPhraseDictionary(response.data);
    isLoadedIntoMemory = true;
    await AsyncStorage.setItem(DICTIONARY_STORAGE_KEY, JSON.stringify(response.data));
    return true;
  } catch (error) {
    return false;
  }
}

async function fetchRemoteVersion(): Promise<PhraseDictionaryVersion | null> {
  try {
    const response = await api.get('/phrase-library/version');
    if (
      response?.data &&
      typeof response.data.count === 'number' &&
      typeof response.data.updatedAt === 'number'
    ) {
      return response.data;
    }
    return null;
  } catch (error) {
    return null;
  }
}

function isSameVersion(a: PhraseDictionaryVersion, b: PhraseDictionaryVersion): boolean {
  return a.count === b.count && a.updatedAt === b.updatedAt;
}

async function synchronizeDictionary(): Promise<void> {
  const remoteVersion = await fetchRemoteVersion();

  if (!remoteVersion) {
    if (!isLoadedIntoMemory) {
      await loadFromDisk();
    }
    return;
  }

  const localVersion = await readLocalVersion();

  if (localVersion && isSameVersion(localVersion, remoteVersion)) {
    if (!isLoadedIntoMemory) {
      const loadedFromDisk = await loadFromDisk();
      if (loadedFromDisk) return;
    } else {
      return;
    }
  }

  const loadedFromNetwork = await loadFromNetwork();
  if (loadedFromNetwork) {
    await writeLocalVersion(remoteVersion);
    return;
  }

  if (!isLoadedIntoMemory) {
    await loadFromDisk();
  }
}

export function ensurePhraseDictionaryLoaded(): Promise<void> {
  if (inFlightLoad) return inFlightLoad;

  inFlightLoad = synchronizeDictionary().finally(() => {
    inFlightLoad = null;
  });

  return inFlightLoad;
}

export function resetPhraseDictionaryCache(): void {
  isLoadedIntoMemory = false;
  inFlightLoad = null;
}