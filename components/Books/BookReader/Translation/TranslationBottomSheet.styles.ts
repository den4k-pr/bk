import { colors } from '../../../../styles/theme';
import { StyleSheet, Dimensions, Platform } from 'react-native';
import { FONT_SIZE } from '../../../../lists/fontSizes';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

/** Ширина картки — використовується і в компоненті (для sweep-анімації) */
export const SHEET_WIDTH = Math.round(SCREEN_WIDTH * 0.92);

export const COLORS = {
  surface: colors.white,
  surfaceSoft: '#f0efefea',
  surfaceSofter: '#FAFBFA',
  border: '#E6E9E7',
  borderSoft: '#EFF1F0',

  ink: '#14211C',
  inkSoft: '#3F4F48',
  muted: '#8A948F',

  green: '#3A5A30',
  greenSoft: '#EAF2E6',
  success: '#4E8C63',
  successRing: '#8FC7A5',
  danger: '#E5484D',

  fabIdle: '#F1F3F2',
};

export const styles = StyleSheet.create({
  bottomSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  },

  /* ── Картка ─────────────────────────────────────────────── */
  sheetActions: {
    width: SHEET_WIDTH,
    overflow: 'hidden',
    backgroundColor: COLORS.surface,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 26,
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 33,
    position: 'relative',
  },

  /* ── Верхня «панель слова» ──────────────────────────────── */
  sheetTopSection: {
    backgroundColor: COLORS.surfaceSoft,
    borderWidth: 1,
    borderColor: COLORS.borderSoft,

    borderRadius: 20,
    paddingTop: 25,
    paddingBottom: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
    width: '100%',
    marginTop: 4,
  },

  wordHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 4,
  },

  /* Кнопка озвучування — тепер у потоці, а не absolute */
  audioButtonOnly: {
    width: 38,
    height: 38,
    borderRadius: 19,
    marginRight: 12,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
    position: "absolute",
    left: -45,
    top: 0
  },
  audioIconCard: {
    width: 19,
    height: 19,
    tintColor: COLORS.green,
  },

  sheetWordText: {
    // Англійське слово / фраза в картці перекладу — 90% від початкового розміру.
    fontSize: (FONT_SIZE.large) * 0.87,
    fontWeight: '800',
    color: COLORS.ink,
    textAlign: 'center',
    letterSpacing: -0.2,
    maxWidth: "75%"
  },

  transcriptionContainer: {
    minHeight: 20,
    justifyContent: 'center',
  },
  transcriptionText: {
    fontSize: FONT_SIZE.small - 1,
    color: COLORS.muted,
    letterSpacing: 0.3,
    textAlign: 'center',
  },

  /* ── Нижня частина ──────────────────────────────────────── */
  sheetBottomSection: {
    paddingTop: 14,
    paddingHorizontal: 12,
    alignItems: 'center',
    width: '100%',
  },

  formsContainerWrapper: {
    minHeight: 26,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  forms_element: {
    backgroundColor: COLORS.surfaceSofter,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  forms_element_text: {
    color: COLORS.inkSoft,
    fontSize: FONT_SIZE.small,
    fontWeight: '600',
    letterSpacing: 0.2,
    textAlign: 'center',
  },

  translationContainer: {
    minHeight: 24,
    justifyContent: 'center',
  },
  translationText: {
    fontSize: FONT_SIZE.medium,
    color: COLORS.inkSoft,
    textAlign: 'center',
    fontWeight: '600',
    lineHeight: FONT_SIZE.medium + 8,
  },

  /* ── Приклади (фрази / фразові дієслова) ────────────────── */
  examples: {
    width: '100%',
    backgroundColor: COLORS.surfaceSofter,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.borderSoft,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 4,
  },
  example_eng: {
    fontSize: FONT_SIZE.small - 2,
    color: COLORS.ink,
    fontWeight: '600',
    lineHeight: FONT_SIZE.small + 6,
    marginBottom: 4,
    textAlign: 'center',
  },
  example_ukr: {
    fontSize: FONT_SIZE.small - 2.8,
    color: COLORS.muted,
    lineHeight: FONT_SIZE.small + 6,
    textAlign: 'center',
  },

  /* ── Іконки центральної кнопки ──────────────────────────── */
  floatingAddIcon: {
    width: 36,
    height: 36,
    tintColor: COLORS.green,
  },
  floatingRemoveIcon: {
    width: 27,
    height: 27,
    tintColor: colors.white,
  },

  buttonPressed: {
    opacity: 0.65,
  },
});