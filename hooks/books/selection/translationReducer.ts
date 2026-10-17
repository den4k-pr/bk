import { ExtendedSelectedPhrase } from '../../../types/BookReader.internal.types';
import { SurfaceAnalysis, WordType } from '../../../types/words';
import { ReaderSelectionSnapshot } from './readerSelectionStore';

export interface LookupRequest {
  context: string;
  /** Натиснуте слово: сервер перекладе його, якщо фраза вжита буквально. */
  fallbackQuery?: string;
  fallbackIndex?: number;
  phraseSurface?: string;
}

export interface TranslationSheetState {
  selectedPhrase: ExtendedSelectedPhrase | null;
  lookup: LookupRequest | null;
  wordDetails: WordType | null;
  isLoadingTranslation: boolean;
  isAdded: boolean;
  isRemoving: boolean;
  userWordId: number | null;
  surfaceTranslation: string | null;
  surfaceAnalysis: SurfaceAnalysis | null;
  verbForms: string[] | null;
  requestId: number;
  isReported: boolean;
}

export type TranslationAction =
  | { type: 'SELECT_WORD'; phrase: ExtendedSelectedPhrase; requestId: number; lookup: LookupRequest }
  | { type: 'SELECT_SENTENCE'; phrase: ExtendedSelectedPhrase }
  | {
      type: 'TRANSLATION_LOADED';
      requestId: number;
      word: WordType;
      isAdded: boolean;
      userWordId: number | null;
      surfaceTranslation?: string | null;
      surfaceAnalysis?: SurfaceAnalysis | null;
      verbForms?: string[] | null;
      phraseRejected?: boolean;
    }
  | { type: 'TRANSLATION_FAILED'; requestId: number; message?: string }
  | { type: 'RETRY'; requestId: number }
  | { type: 'WORD_ADDED' }
  | { type: 'ADD_CONFIRMED'; wordId: number; userWordId: number | null }
  | { type: 'ADD_FAILED'; wordId: number }
  | { type: 'REMOVE_STARTED' }
  | { type: 'WORD_REMOVED' }
  | { type: 'REMOVE_FAILED' }
  | { type: 'REPORTED' }
  | { type: 'RESTORE'; requestId: number; snapshot: ReaderSelectionSnapshot }
  | { type: 'CLEAR' };

export const initialTranslationState: TranslationSheetState = {
  selectedPhrase: null,
  lookup: null,
  wordDetails: null,
  isLoadingTranslation: false,
  isAdded: false,
  isRemoving: false,
  userWordId: null,
  surfaceTranslation: null,
  surfaceAnalysis: null,
  verbForms: null,
  requestId: 0,
  isReported: false,
};

export function translationReducer(
  state: TranslationSheetState,
  action: TranslationAction
): TranslationSheetState {
  switch (action.type) {
    case 'SELECT_WORD':
      return {
        selectedPhrase: action.phrase,
        lookup: action.lookup,
        wordDetails: null,
        isLoadingTranslation: true,
        isAdded: false,
        isRemoving: false,
        userWordId: null,
        surfaceTranslation: null,
        surfaceAnalysis: null,
        verbForms: null,
        requestId: action.requestId,
        isReported: false,
      };

    case 'RETRY':
      if (!state.selectedPhrase || state.selectedPhrase.type !== 'word') return state;
      return {
        ...state,
        wordDetails: null,
        isLoadingTranslation: true,
        surfaceTranslation: null,
        surfaceAnalysis: null,
        verbForms: null,
        requestId: action.requestId,
      };

    case 'SELECT_SENTENCE':
      return {
        ...state,
        selectedPhrase: action.phrase,
        lookup: null,
        wordDetails: null,
        isLoadingTranslation: false,
        isAdded: false,
        isRemoving: false,
        userWordId: null,
        isReported: false,
      };

    case 'TRANSLATION_LOADED': {
      if (action.requestId !== state.requestId || !state.selectedPhrase) return state;
      // Фразу відхилено (слова вжиті буквально) — виділяємо лише натиснуте слово.
      const fallbackIndex = state.lookup?.fallbackIndex;
      const selectedPhrase =
        action.phraseRejected && typeof fallbackIndex === 'number'
          ? {
              startIdx: fallbackIndex,
              endIdx: fallbackIndex,
              text: state.lookup?.fallbackQuery ?? action.word.text,
              type: 'word' as const,
            }
          : state.selectedPhrase;
      return {
        ...state,
        selectedPhrase,
        wordDetails: action.word,
        isLoadingTranslation: false,
        isAdded: action.isAdded,
        userWordId: action.userWordId,
        surfaceTranslation: action.surfaceTranslation ?? null,
        surfaceAnalysis: action.surfaceAnalysis ?? null,
        verbForms: Array.isArray(action.verbForms) && action.verbForms.length > 0 ? action.verbForms : null,
      };
    }

    case 'TRANSLATION_FAILED':
      if (action.requestId !== state.requestId) return state;
      return {
        ...state,
        isLoadingTranslation: false,
        wordDetails: {
          id: 0,
          text: state.selectedPhrase?.text || 'Помилка',
          translation: action.message || 'Не вдалося знайти переклад',
          partOfSpeech: 'none',
        } as WordType,
      };

    case 'WORD_ADDED':
      return {
        ...state,
        isAdded: true,
      };

    // Відповідь сервера на додавання — лише якщо шторка досі про те саме слово.
    case 'ADD_CONFIRMED':
      if (state.wordDetails?.id !== action.wordId) return state;
      return { ...state, isAdded: true, userWordId: action.userWordId ?? state.userWordId };

    case 'ADD_FAILED':
      if (state.wordDetails?.id !== action.wordId) return state;
      return { ...state, isAdded: false };

    case 'REMOVE_STARTED':
      return {
        ...state,
        isRemoving: true,
      };

    case 'WORD_REMOVED':
      return {
        ...state,
        isAdded: false,
        isRemoving: false,
        userWordId: null,
      };

    case 'REMOVE_FAILED':
      return {
        ...state,
        isRemoving: false,
      };

    case 'REPORTED':
      return {
        ...state,
        isReported: true,
      };

    case 'CLEAR':
      return {
        ...state,
        selectedPhrase: null,
        lookup: null,
        wordDetails: null,
        isLoadingTranslation: false,
        isAdded: false,
        isRemoving: false,
        userWordId: null,
        surfaceAnalysis: null,
        verbForms: null,
        isReported: false,
      };

    case 'RESTORE': {
      const saved = action.snapshot;
      if (!saved.selectedPhrase) return state;
      const isWord = saved.selectedPhrase.type === 'word';
      // Картка з помилкою (id 0) або ще не завантажена — запитуємо заново.
      const card = saved.wordDetails && saved.wordDetails.id ? saved.wordDetails : null;
      return {
        selectedPhrase: saved.selectedPhrase,
        lookup: saved.lookup,
        wordDetails: card,
        isLoadingTranslation: isWord && !card,
        isAdded: !!card && saved.isAdded,
        isRemoving: false,
        userWordId: card ? saved.userWordId : null,
        surfaceTranslation: card ? saved.surfaceTranslation : null,
        surfaceAnalysis: card ? saved.surfaceAnalysis : null,
        verbForms: card ? saved.verbForms : null,
        requestId: action.requestId,
        isReported: saved.isReported,
      };
    }

    default:
      return state;
  }
}
