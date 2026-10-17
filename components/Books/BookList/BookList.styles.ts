import { colors } from '../../../styles/theme';
import { StyleSheet, Dimensions } from 'react-native';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    backgroundColor: '#FAFDFB' 
  },

  // --- ХЕДЕР ТА КНОПКА ФІЛЬТРА ---
  headerContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    
    paddingVertical: 10,
    backgroundColor: colors.neutral,
    borderBottomWidth: 1,
    borderBottomColor: '#E2ECE9',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1C2E24',
  },
  // 🟢 Було inline `{ flexDirection: 'row', alignItems: 'center', gap: 10 }`
  // прямо в JSX — перенесено сюди, щоб RN міг посилатись на готовий,
  // один раз створений об'єкт стилю замість нового літерала на кожен рендер.
  headerActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  filterTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2ECE9',
  },
  filterTriggerText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2E7D32',
    marginRight: 6,
  },
  arrowIcon: {
    width: 10,
    height: 10,
    tintColor: '#2E7D32',
    resizeMode: 'contain',
    transform: [{ rotate: '90deg' }],
  },

  // --- ПОМИЛКА ЗАВАНТАЖЕННЯ ---
  // 🟢 Перенесено з inline-об'єктів у JSX (errorBox / errorBoxText /
  // errorRetryButton / errorRetryButtonText).
  errorBox: {
    padding: 20,
    backgroundColor: '#ffebee',
    borderRadius: 10,
    margin: 16,
  },
  errorBoxText: {
    color: '#c62828',
    textAlign: 'center',
    fontWeight: 'bold',
  },
  errorRetryButton: {
    marginTop: 10,
    padding: 10,
    backgroundColor: '#c62828',
    borderRadius: 5,
  },
  errorRetryButtonText: {
    color: 'white',
    textAlign: 'center',
  },

  // --- ЗАВАНТАЖЕННЯ ТА ПУСТИЙ СТАН ---
  loaderContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loaderText: {
    marginTop: 12,
    fontSize: 15,
    color: '#64748B',
    fontWeight: '500',
  },
  emptyText: {
    textAlign: 'center',
    marginTop: 40,
    fontSize: 16,
    color: '#94A3B8',
  },

  // --- СПИСОК КНИГ ---
  listContent: { 
    padding: 12 
  },
  rowWrapper: { 
    justifyContent: 'space-between' 
  },
  bookCard: {
    width: (SCREEN_WIDTH - 36) / 2,
    backgroundColor: colors.white,
    borderRadius: 6,
    marginBottom: 16,
    overflow: 'hidden',
    elevation: 3,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
  },
  levelTag: {
    position: 'absolute',
    top: 10, 
    left: 10, 
    zIndex: 10,
    paddingHorizontal: 8, 
    paddingVertical: 4, 
    borderRadius: 6,
  },
  levelTagText: { 
    color: colors.white, 
    fontSize: 11, 
    fontWeight: 'bold' 
  },
  bookCover: { 
    width: '100%', 
    height: 250, 
    backgroundColor: colors.border 
  },
  cardInfo: { 

  },
  bookTitle: { 
    fontSize: 16, 
    fontWeight: '700', 
    color: '#1C2E24', 
    lineHeight: 18, 
    height: 36 
  },
  progressText: { 
    fontSize: 16, 
    color: '#FF9800', 
    fontWeight: '600', 
    textTransform: "uppercase",
    marginTop: 8 
  },
  progressBarBg: { 
    height: 6, 
    backgroundColor: '#EBEFF1', 
    borderRadius: 3, 
    marginTop: 4, 
    overflow: 'hidden' 
  },
  progressBarFill: { 
    height: '100%', 
    borderRadius: 3,
    backgroundColor: '#FF9800',
  },

  // --- МОДАЛЬНЕ ВІКНО ---
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(26, 26, 26, 0.5)', 
    justifyContent: 'center',
    alignItems: 'center',
  },
  popupCard: {
    width: SCREEN_WIDTH * 0.85,
    backgroundColor: colors.white,
    borderRadius: 24,
    padding: 24,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 10,
  },
  popupTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#2A1E17',
    textAlign: 'center',
    marginBottom: 20,
  },
  unlockedSection: {
    gap: 8,
  },
  levelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 16,
    backgroundColor: '#F8F9FA',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  levelRowActive: {
    backgroundColor: '#FFFBF2',
    borderColor: '#FDB226',
  },
  levelText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#4A3E36',
  },
  levelTextActive: {
    color: '#D99100',
  },
  activeDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#FDB226',
  },

iconButton: { 
    width: 28, 
    height: 40,
    justifyContent: "center",
    alignItems: "center"
  },
  iconButton_img: {
    width: 20,
    height: 20
  },
  buttonActive: {
    opacity: 0.7,
    transform: [{ scale: 0.95 }]
  },

});