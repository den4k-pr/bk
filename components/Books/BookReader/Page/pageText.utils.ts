import { ExtendedSelectedPhrase } from '../../../../types/BookReader.internal.types';
import { BackHighlight } from '../../../../types/books';
import { NEWLINE_TEST, WHITESPACE_TEST } from './page.constants';
import { ParagraphBlock } from './page.types';

export function parseBoldIndices(boldIndices: unknown): number[] {
  if (!boldIndices) return [];
  if (Array.isArray(boldIndices)) return boldIndices;
  if (typeof boldIndices === 'string') {
    try {
      const parsed = JSON.parse(boldIndices);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }
  return [];
}

export function buildHighlightColorMap(pageHighlights: BackHighlight[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const h of pageHighlights) {
    for (let i = h.startIndex; i <= h.endIndex; i++) {
      map.set(i, h.color);
    }
  }
  return map;
}

export function splitIntoParagraphBlocks(textChunks: string[]): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  let start = 0;
  for (let i = 0; i < textChunks.length; i++) {
    const chunk = textChunks[i];
    const isBreakToken =
      typeof chunk === 'string' && WHITESPACE_TEST.test(chunk) && NEWLINE_TEST.test(chunk);
    if (isBreakToken && i > start) {
      blocks.push({ startIdx: start, endIdx: i - 1 });
      start = i;
    }
  }
  if (start <= textChunks.length - 1) {
    blocks.push({ startIdx: start, endIdx: textChunks.length - 1 });
  }
  return blocks;
}

export function computeSelectionRanges(
  localSelectedPhrase: ExtendedSelectedPhrase | null,
  draggedRange: { start: number; end: number } | null,
) {
  let translatedMin = Number.POSITIVE_INFINITY;
  let translatedMax = Number.NEGATIVE_INFINITY;
  let translatedExact: number[] | null = null;

  if (localSelectedPhrase?.type === 'word') {
    if (localSelectedPhrase.exactIndicesToHighlight) {
      translatedExact = localSelectedPhrase.exactIndicesToHighlight;
      for (const i of translatedExact) {
        if (i < translatedMin) translatedMin = i;
        if (i > translatedMax) translatedMax = i;
      }
    } else {
      translatedMin = localSelectedPhrase.startIdx;
      translatedMax = localSelectedPhrase.endIdx;
    }
  }

  let highlightingMin = Number.POSITIVE_INFINITY;
  let highlightingMax = Number.NEGATIVE_INFINITY;

  if (draggedRange) {
    highlightingMin = draggedRange.start;
    highlightingMax = draggedRange.end;
  } else if (localSelectedPhrase?.type === 'sentence') {
    highlightingMin = localSelectedPhrase.startIdx;
    highlightingMax = localSelectedPhrase.endIdx;
  }

  return { translatedMin, translatedMax, translatedExact, highlightingMin, highlightingMax };
}
