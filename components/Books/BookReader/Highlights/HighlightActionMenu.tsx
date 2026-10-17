import { colors } from '../../../../styles/theme';
import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable, LayoutChangeEvent } from 'react-native';
import { Trash2 } from 'lucide-react-native';
import { HIGHLIGHT_COLORS, SCREEN_WIDTH } from '../BookReader.constants';
import { CopyHighlightButton } from './CopyHighlightButton';

const HIGHLIGHT_MENU_EDGE_MARGIN = 12;
// Відстань між натиснутим текстом і верхом панелі: піднімаємо панель вище,
// щоб вона стояла чітко НАД обведеним текстом, а не торкалась/наїжджала на нього.
const HIGHLIGHT_MENU_VERTICAL_OFFSET = 60;
const HIGHLIGHT_MENU_TOP_MIN = 50;
const HIGHLIGHT_MENU_FALLBACK_WIDTH = 200;
// Половина ширини стрілочки-трикутника (він же висота трикутника).
const HIGHLIGHT_MENU_ARROW_SIZE = 7;

interface HighlightActionMenuCoords {
  x: number;
  y: number;
}

interface HighlightActionMenuProps {
  coords: HighlightActionMenuCoords;
  /** Зсув readerContainer відносно вікна (safe-area/хедер) — віднімаємо, бо
   *  coords приходять у ВІКОННИХ координатах, а меню позиціонується всередині
   *  readerContainer. */
  containerOffset?: { x: number; y: number };
  onColorSelect: (color: string) => void;
  onCopyText: () => string;
  onRemove?: () => void;
}

export const HighlightActionMenu = React.memo<HighlightActionMenuProps>(function HighlightActionMenu({
  coords,
  containerOffset = { x: 0, y: 0 },
  onColorSelect,
  onCopyText,
  onRemove,
}) {
  const [measuredWidth, setMeasuredWidth] = useState<number>(0);

  useEffect(() => {
    setMeasuredWidth(0);
  }, [coords.x, coords.y]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    setMeasuredWidth((previous) => (Math.abs(previous - width) > 0.5 ? width : previous));
  }, []);

  const effectiveWidth = measuredWidth > 0 ? measuredWidth : HIGHLIGHT_MENU_FALLBACK_WIDTH;

  // Переводимо віконні координати у координати readerContainer.
  const localX = coords.x - containerOffset.x;
  const localY = coords.y - containerOffset.y;

  const minLeft = HIGHLIGHT_MENU_EDGE_MARGIN;
  const maxLeft = Math.max(minLeft, SCREEN_WIDTH - HIGHLIGHT_MENU_EDGE_MARGIN - effectiveWidth);
  const desiredLeft = localX - effectiveWidth / 2;
  const left = Math.min(Math.max(minLeft, desiredLeft), maxLeft);

  const top = Math.max(HIGHLIGHT_MENU_TOP_MIN, localY - HIGHLIGHT_MENU_VERTICAL_OFFSET);

  // Стрілочка має вказувати точно на натиснутий текст: центр трикутника
  // ставимо на localX (відносно панелі), затиснувши в межі панелі.
  const rawArrowCenterX = localX - left;
  const arrowLeft = Math.min(
    Math.max(rawArrowCenterX - HIGHLIGHT_MENU_ARROW_SIZE, 4),
    effectiveWidth - HIGHLIGHT_MENU_ARROW_SIZE * 2 - 4,
  );

  return (
    <View
      onLayout={handleLayout}
      style={{
        position: 'absolute',
        top,
        left,
        opacity: measuredWidth === 0 ? 0 : 1,
        zIndex: 1000,
        elevation: 5,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: '#1C1F1E',
          paddingVertical: 6,
          paddingHorizontal: 8,
          borderRadius: 12,
          gap: 10,
          shadowColor: colors.black,
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.25,
          shadowRadius: 10,
          elevation: 5,
        }}
      >
        {HIGHLIGHT_COLORS.map((color) => (
          <Pressable
            key={color}
            onPress={() => onColorSelect(color)}
            style={{
              width: 26,
              height: 26,
              borderRadius: 25,
              backgroundColor: color,
              borderWidth: 1.5,
              borderColor: 'rgba(255,255,255,0.9)',
            }}
          />
        ))}

        <CopyHighlightButton getTextToCopy={onCopyText} />

        {onRemove && (
          <Pressable
            onPress={onRemove}
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              backgroundColor: '#3a3a3a',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {/* Видалити позначку кольором — іконка смітника. */}
            <Trash2 size={18} color={colors.white} strokeWidth={2.2} />
          </Pressable>
        )}
      </View>

      {/* Стрілочка-трикутник, що вказує на обведений текст. */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: '100%',
          left: arrowLeft,
          marginTop: -1,
          width: 0,
          height: 0,
          borderLeftWidth: HIGHLIGHT_MENU_ARROW_SIZE,
          borderRightWidth: HIGHLIGHT_MENU_ARROW_SIZE,
          borderTopWidth: HIGHLIGHT_MENU_ARROW_SIZE,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderTopColor: '#1C1F1E',
        }}
      />
    </View>
  );
});
