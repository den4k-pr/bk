import { colors } from '../../../styles/theme';
import { StyleSheet, Dimensions, Platform } from 'react-native';
import { FONT_SIZE } from '../../../lists/fontSizes';
import { RFValue } from 'react-native-responsive-fontsize';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export const stylesReader = StyleSheet.create({
  readerContainer: { 
    flex: 1, 
    backgroundColor: '#FDFDFB' 
  },
  readerHeader: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    paddingHorizontal: 15, 
    paddingVertical: 10,
    backgroundColor: colors.neutral,
    borderBottomWidth: 1,
    borderBottomColor: '#E2ECE9',
    zIndex: 110,
  },
  backButton: { 
    paddingVertical: 6,
  },
  backButtonImage: {
    width: 30,
    height: 30
  },
  backButtonText: { 
    fontSize: 14, 
    color: '#64748B', 
    fontWeight: '600',
  },
  pageIndicatorContainer: {
    position: "absolute",
    bottom: 20,
    alignSelf: "center",
    backgroundColor: "rgba(30, 30, 30, 0.68)",
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 20,
    zIndex: 1,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
  },
  pageIndicator: {
    color: colors.white,
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 1,
  },
  audioIconControler: {
    position: "absolute",
    justifyContent: "center",
    alignItems: "center",
    bottom: -64,
    width: 80,
    backgroundColor: "#E2F0E7",
    borderRadius: 5,
    padding: 7
  },
  audioIconControlerText: {
    fontSize: FONT_SIZE.medium
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: RFValue(5)
  },
  iconButton: { 
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 2,
  },
  // Іконки хедера (навушники, закладки) — на 20% менші за стрілку назад.
  iconButton_img: {
    width: 20,
    height: 20,
    resizeMode: 'contain',
  },
  buttonActive: {
    opacity: 0.7,
    transform: [{ scale: 0.95 }]
  },
  sliderWrapper: {
    flex: 1,
    position: 'relative'
  },
  pageContainer: {
    width: SCREEN_WIDTH,
    height: '100%',
    backgroundColor: '#FDFDFB',
    paddingHorizontal: 20,
  },
  scrollPadding: {
    paddingTop: 28,
    paddingBottom: 110, 
  },
  chapterSubtitle: {
    fontSize: 12,
    color: '#10B981', 
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginBottom: 8,
    fontWeight: '800',
  },
  headerTitleText: {
    textAlign: "center",
    fontSize: FONT_SIZE.preMini,
    fontWeight: "600",
    marginLeft: 45
  },
  chapterTitleWrapper: {
    flex: 1, 
    position: "absolute", 
    left: "50%" ,
    transform: [{translateX: "-43%"}]
  },
  chapterTitle: { 
    textAlign: "center", 
    fontWeight: '800', 
    color: '#0F172A', 
  },
  divider: {
    width: 32,
    height: 4,
    backgroundColor: '#E2E8F0',
    borderRadius: 2,
    marginTop: 20,
    marginBottom: 28,
  },
  textBlockContainer: {
    minHeight: 100,
    position: 'relative',
  },
  bodyText: { 
    color: '#334155', 
    textAlign: 'left',
    includeFontPadding: false,
  },
  fontDropdownOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
  },
  fontDropdown: {
    position: 'absolute',
    top: 20,
    right: 20,
    backgroundColor: colors.white,
    borderRadius: 16,
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 101,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    ...Platform.select({
      ios: { shadowColor: '#0F172A', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.1, shadowRadius: 12 },
      android: { elevation: 5 }
    }),
  },
  fontBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fontBtnText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#475569',
  },
  fontDivider: {
    width: 1,
    height: 20,
    backgroundColor: '#E2E8F0',
  },
  buttonPressed: {
    opacity: 0.6,
  },
  overlay: {
    zIndex: 90,
  },
  // ═══════════════════════════════════════════════════════════════════════
  // 🔴 ФІКС "КАРТИНКА СТРИБАЄ В X3 І НАЗАД":
  //
  // Раніше тут в ОДНОМУ стилі одночасно стояли:
  //   height: SCREEN_WIDTH * 0.5   → співвідношення сторін 2 : 1
  //   aspectRatio: 16 / 9           → співвідношення сторін ≈ 1.78 : 1
  // Це ДВА КОНФЛІКТНІ обмеження одного й того самого виміру (висоти) для
  // ОДНОГО й того самого Image. Поки картинка ще не має реальних пікселів
  // з мережі, Yoga/нативний шар Image міг на різних проходах лейауту
  // (перший рендер → підвантаження реального розміру з мережі → коміт)
  // "передумувати", яке з двох обмежень застосувати — звідси видимий
  // стрибок розміру і повернення назад.
  //
  // Фікс: розмір тепер визначає ЛИШЕ pageHeaderImageWrapper — звичайний
  // View з фіксованими width/height і overflow:'hidden', що НІЯК не
  // залежить від того, що і коли підвантажив Image. Сам pageHeaderImage
  // (застосовується до Image всередині wrapper-а) тепер просто
  // StyleSheet.absoluteFillObject — Image завжди рівно заповнює вже
  // готовий, стабільний розмір батька, resizeMode="cover" сам подбає про
  // обрізання зображення під ці межі. Розмір самого Image фізично більше
  // ні від чого не залежить і не може "стрибнути".
  // ═══════════════════════════════════════════════════════════════════════
  pageHeaderImageWrapper: {
    width: '100%',
    height: SCREEN_WIDTH * 0.5,
    backgroundColor: colors.divider,
    marginBottom: 16,
    overflow: 'hidden',
  },
  pageHeaderImage: {
    ...StyleSheet.absoluteFillObject,
  },
});