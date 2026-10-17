import React from 'react';
import { View } from 'react-native';
import FastImage from 'react-native-fast-image';
import { stylesReader } from '../BookReader.styles';

export const PageHeaderImage = React.memo(function PageHeaderImage({
  imageUrl,
}: {
  imageUrl: string;
}) {
  return (
    <View style={stylesReader.pageHeaderImageWrapper}>
      <FastImage
        style={stylesReader.pageHeaderImage}
        source={{
          uri: imageUrl,
          priority: FastImage.priority.high,
          cache: FastImage.cacheControl.immutable,
        }}
        resizeMode={FastImage.resizeMode.cover}
      />
    </View>
  );
});
