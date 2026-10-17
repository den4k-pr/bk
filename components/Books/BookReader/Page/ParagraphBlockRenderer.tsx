import React, { useMemo } from 'react';
import { View } from 'react-native';
import { WordChunk } from './WordChunk';

interface ParagraphBlockRendererProps {
  blockIndex: number;
  chunks: string[];
  baseIndex: number;
  fontSize: number;
  boldSet: Set<number>;
  highlightColorByIndex: Map<number, string>;
  translatedMin: number;
  translatedMax: number;
  translatedExact: number[] | null;
  highlightingMin: number;
  highlightingMax: number;
  onWordLayout: (
    index: number,
    x: number,
    y: number,
    w: number,
    h: number,
    blockIndex: number,
  ) => void;
  onBlockLayout: (blockIndex: number, y: number, height: number) => void;
}

export const ParagraphBlockRenderer = React.memo(
  ({
    blockIndex,
    chunks,
    baseIndex,
    fontSize,
    boldSet,
    highlightColorByIndex,
    translatedMin,
    translatedMax,
    translatedExact,
    highlightingMin,
    highlightingMax,
    onWordLayout,
    onBlockLayout,
  }: ParagraphBlockRendererProps) => {
    const blockEndIndex = baseIndex + chunks.length - 1;
    const overlapsTranslated = translatedMax >= baseIndex && translatedMin <= blockEndIndex;
    const overlapsHighlighting = highlightingMax >= baseIndex && highlightingMin <= blockEndIndex;

    const depTranslatedMin = overlapsTranslated ? translatedMin : -1;
    const depTranslatedMax = overlapsTranslated ? translatedMax : -1;
    const depTranslatedExact = overlapsTranslated ? translatedExact : null;
    const depHighlightingMin = overlapsHighlighting ? highlightingMin : -1;
    const depHighlightingMax = overlapsHighlighting ? highlightingMax : -1;

    const renderedWords = useMemo(() => {
      return chunks.map((chunk: string, localIndex: number) => {
        const globalIndex = baseIndex + localIndex;
        const isSavedBoldWord = boldSet.has(globalIndex);

        const isTranslatedWord = depTranslatedExact
          ? depTranslatedExact.includes(globalIndex)
          : globalIndex >= depTranslatedMin && globalIndex <= depTranslatedMax;

        const isBeingHighlighted =
          globalIndex >= depHighlightingMin && globalIndex <= depHighlightingMax;

        const savedHighlightColor = highlightColorByIndex.get(globalIndex);
        const nextChunk = chunks[localIndex + 1];

        return (
          <WordChunk
            key={globalIndex}
            blockIndex={blockIndex}
            chunk={chunk}
            nextChunk={nextChunk}
            index={globalIndex}
            fontSize={fontSize}
            isSavedBoldWord={isSavedBoldWord}
            isTranslatedWord={isTranslatedWord}
            isBeingHighlighted={isBeingHighlighted}
            savedHighlightColor={savedHighlightColor}
            onWordLayout={onWordLayout}
          />
        );
      });
    }, [
      chunks,
      baseIndex,
      boldSet,
      highlightColorByIndex,
      depTranslatedMin,
      depTranslatedMax,
      depTranslatedExact,
      depHighlightingMin,
      depHighlightingMax,
      fontSize,
      onWordLayout,
      blockIndex,
    ]);

    return (
      <View
        onLayout={(e) =>
          onBlockLayout(blockIndex, e.nativeEvent.layout.y, e.nativeEvent.layout.height)
        }
        style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', width: '100%' }}
      >
        {renderedWords}
      </View>
    );
  },
);
