import React from 'react';
import { View, Text } from 'react-native';
import { stylesReader } from '../BookReader.styles';
import { LETTER_TEST, NEWLINE_TEST, WHITESPACE_TEST } from './page.constants';

interface WordChunkProps {
  blockIndex: number;
  chunk: string;
  nextChunk?: string;
  index: number;
  fontSize: number;
  isSavedBoldWord: boolean;
  isTranslatedWord: boolean;
  isBeingHighlighted: boolean;
  savedHighlightColor?: string;
  onWordLayout: (
    index: number,
    x: number,
    y: number,
    w: number,
    h: number,
    blockIndex: number,
  ) => void;
}

export const WordChunk = React.memo(
  ({
    blockIndex,
    chunk,
    nextChunk,
    index,
    fontSize,
    isSavedBoldWord,
    isTranslatedWord,
    isBeingHighlighted,
    savedHighlightColor,
    onWordLayout,
  }: WordChunkProps) => {
    const textStyle = [stylesReader.bodyText, { fontSize, lineHeight: fontSize * 1.5 }];

    if (WHITESPACE_TEST.test(chunk)) {
      if (NEWLINE_TEST.test(chunk)) {
        const newlineCount = chunk.match(/\n/g)?.length || 0;
        const spacesOnly = chunk.replace(/\n/g, '');
        return (
          <React.Fragment>
            <View style={{ width: '100%', height: newlineCount > 1 ? fontSize * 0.8 : 0 }} />
            {spacesOnly.length > 0 && <Text style={textStyle}>{spacesOnly}</Text>}
          </React.Fragment>
        );
      }
      return null;
    }

    const hasTrailingSpace =
      nextChunk !== undefined && WHITESPACE_TEST.test(nextChunk) && !nextChunk.includes('\n');

    const hasLetter = LETTER_TEST.test(chunk);

    if (!hasLetter) {
      return (
        <React.Fragment>
          <Text style={textStyle}>{chunk}</Text>
          {hasTrailingSpace && <Text style={textStyle}> </Text>}
        </React.Fragment>
      );
    }

    let wordBorderColor = 'transparent';
    let wordBgColor = 'transparent';
    let borderRadius = 0;
    let borderWidth = 1;

    const dynamicTextStyle = isSavedBoldWord
      ? { fontFamily: 'notosans_condensed_bold', fontWeight: '600' as const }
      : undefined;

    if (isTranslatedWord) {
      wordBgColor = '#dff5cf89';
      wordBorderColor = '#10b981';
      borderWidth = 1;
      borderRadius = 4;
    } else if (isBeingHighlighted) {
      wordBgColor = '#EDEFD9';
      wordBorderColor = 'transparent';
      borderWidth = 1;
      borderRadius = 0;
    } else if (savedHighlightColor) {
      wordBgColor = savedHighlightColor;
      wordBorderColor = 'transparent';
      borderWidth = 1;
      borderRadius = 0;
    }

    return (
      <View
        onLayout={(e) => {
          const { x, y, width, height } = e.nativeEvent.layout;
          onWordLayout(index, x, y, width, height, blockIndex);
        }}
        style={{ flexDirection: 'row' }}
      >
        <Text
          style={[
            textStyle,
            dynamicTextStyle,
            {
              borderWidth: borderWidth,
              borderColor: wordBorderColor,
              backgroundColor: wordBgColor,
              borderRadius: borderRadius,
              paddingHorizontal: 3,
              marginHorizontal: -2,
            },
          ]}
        >
          {chunk}
        </Text>
        {hasTrailingSpace && <Text style={textStyle}> </Text>}
      </View>
    );
  },
);
