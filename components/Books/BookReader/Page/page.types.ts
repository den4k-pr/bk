import { ExtendedSelectedPhrase } from '../../../../types/BookReader.internal.types';
import { BackHighlight, ReaderPage } from '../../../../types/books';
import { PhraseMatch } from '../Phrases/phraseDetection';

export interface ReaderPageItemProps {
  item: ReaderPage;
  width: number;
  fontSize: number;
  selectedPhrase: ExtendedSelectedPhrase | null;
  pageHighlights: BackHighlight[];
  isContentLoading?: boolean;
  initialScrollProgress?: number;
  onWordPress: (
    chunks: string[],
    index: number,
    eventX: number,
    eventY: number,
    precomputedMatch: PhraseMatch | null,
  ) => void;
  onWordLongPress: (chunks: string[], index: number, eventX: number, eventY: number) => void;
  onSentenceSelect: (phrase: {
    startIdx: number;
    endIdx: number;
    text: string;
    pageX: number;
    pageY: number;
  }) => void;
  onSelectionModeChange: (active: boolean) => void;
  onScrollBeginDrag: () => void;
  onEmptyPress: () => void;
  onScrollProgress?: (pageId: number, progress: number) => void;
  onHighlightedWordPress?: (
    pageId: number,
    highlight: BackHighlight,
    pageX: number,
    pageY: number,
  ) => void;
}

export interface ReaderPageItemHandle {
  scrollToProgress: (progress: number) => void;
  scrollByOffset: (delta: number) => void;
  /**
   * Прокрутити так, щоб слова (індекси) стояли над панеллю перекладу.
   * coveredHeight — скільки знизу сторінки закриває панель.
   */
  revealIndices: (indices: number[], coveredHeight: number) => void;
}

export interface WordLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  blockIndex: number;
}

export interface BlockLayout {
  y: number;
  height: number;
}

export interface ParagraphBlock {
  startIdx: number;
  endIdx: number;
}
