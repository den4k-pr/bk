import { RFValue } from "react-native-responsive-fontsize";

export const FONT_SIZE = {
  mini: RFValue(10),
  preMini: RFValue(11),
  verySmall: RFValue(12),
  small: RFValue(13),
  medium: RFValue(14),
  preLarge: RFValue(16),
  mediumLarge: RFValue(20),
  large: RFValue(24),
  preBig: RFValue(30),
  big: RFValue(35),
};

// Єдиний розмір шрифту «брови» з рівнем ("A1 РІВЕНЬ") на всіх картках:
// CardDeck, мікрофон і картки Словника. Еталон — перший режим CardDeck.
export const LEVEL_EYEBROW_FONT_SIZE = 20;
