import { colors } from '../../../../styles/theme';
import React from 'react';
import { View, Pressable, Image } from 'react-native';
import { MoreVertical } from 'lucide-react-native';
import { stylesReader } from '../BookReader.styles';
import { ChapterTitle } from '../../../../widgets/ChapterTitle';

interface ReaderHeaderBarProps {
  title: string;
  onBack: () => void;
  onBookmarkPress: () => void;
  onDotsPress: () => void;
  bookmarkButtonRef?: React.RefObject<View | null>;
  dotsButtonRef?: React.RefObject<View | null>;
}

export const ReaderHeaderBar = React.memo<ReaderHeaderBarProps>(function ReaderHeaderBar({
  title,
  onBack,
  onBookmarkPress,
  onDotsPress,
  bookmarkButtonRef,
  dotsButtonRef,
}) {
  return (
    <View style={stylesReader.readerHeader}>
      <Pressable onPress={onBack} style={stylesReader.backButton}>
        <Image
          source={require('../../../../../assets/images/icons/arrowBack.png')}
          style={stylesReader.backButtonImage}
        />
      </Pressable>

      <View style={stylesReader.chapterTitleWrapper}>
        <ChapterTitle maxFontSize={16} minFontScale={0.4} numberOfLines={2} title={title} wrapper_width={0.5} />
      </View>

      <View style={stylesReader.headerRight}>
        {/* Аудіокнига: чекає на готові аудіозаписи (ElevenLabs). Системний TTS
            прибрано — поки записів немає, кнопка неактивна. */}
        <View
          style={[stylesReader.iconButton, { opacity: 0.35 }]}
          accessibilityRole="button"
          accessibilityLabel="Аудіокнига (незабаром)"
          accessibilityState={{ disabled: true }}
        >
          <Image
            source={require('../../../../../assets/images/icons/headphones.png')}
            style={stylesReader.iconButton_img}
          />
        </View>

        <View collapsable={false} ref={bookmarkButtonRef}>
          <Pressable
            style={({ pressed }) => [
              stylesReader.iconButton,
              pressed && stylesReader.buttonActive,
            ]}
            onPress={onBookmarkPress}
          >
            <Image
              source={require('../../../../../assets/images/icons/bookmark-4.png')}
              style={stylesReader.iconButton_img}
            />
          </Pressable>
        </View>

        <View collapsable={false} ref={dotsButtonRef}>
          <Pressable
            style={({ pressed }) => [
              stylesReader.iconButton,
              pressed && stylesReader.buttonActive,
              {width: 18}
            ]}
            onPress={onDotsPress}
          >
            <MoreVertical size={22} color={colors.black} strokeWidth={2.3} />
          </Pressable>
        </View>
      </View>
    </View>
  );
});
