import React from 'react';
import { Pressable, StyleSheet, Text, TouchableWithoutFeedback, View } from 'react-native';
import { stylesReader } from '../BookReader.styles';
import { MIN_FONT_SIZE, MAX_FONT_SIZE } from './readerFontSize';

interface FontSizePanelProps {
  fontSize: number;
  onDecrease: () => void;
  onIncrease: () => void;
  onClose: () => void;
  panelRef?: React.RefObject<View | null>;
}

export const FontSizePanel: React.FC<FontSizePanelProps> = ({ fontSize, onDecrease, onIncrease, onClose, panelRef }) => {
  return (
    <>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={stylesReader.fontDropdownOverlay} />
      </TouchableWithoutFeedback>
      <View style={stylesReader.fontDropdown} ref={panelRef}>
        <Pressable
          style={({ pressed }) => [
            stylesReader.fontBtn,
            pressed && stylesReader.buttonPressed,
            fontSize <= MIN_FONT_SIZE && localStyles.fontBtnDisabled,
          ]}
          disabled={fontSize <= MIN_FONT_SIZE}
          onPress={onDecrease}
        >
          <Text style={stylesReader.fontBtnText}>A−</Text>
        </Pressable>

        <View style={localStyles.fontValueBadge}>
          <Text style={localStyles.fontValueText}>{fontSize}</Text>
        </View>

        <Pressable
          style={({ pressed }) => [
            stylesReader.fontBtn,
            pressed && stylesReader.buttonPressed,
            fontSize >= MAX_FONT_SIZE && localStyles.fontBtnDisabled,
          ]}
          disabled={fontSize >= MAX_FONT_SIZE}
          onPress={onIncrease}
        >
          <Text style={stylesReader.fontBtnText}>A+</Text>
        </Pressable>
      </View>
    </>
  );
};

const localStyles = StyleSheet.create({
  fontValueBadge: {
    minWidth: 34,
    paddingVertical: 3,
    paddingHorizontal: 6,
    marginHorizontal: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(20,33,28,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fontValueText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#3F4F48',
    fontVariant: ['tabular-nums'],
  },
  fontBtnDisabled: {
    opacity: 0.35,
  },
});
