import { colors } from '../../../styles/theme';
import {
  StyleSheet,
} from 'react-native';

export const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 16,
    width: '92%',
    // maxHeight (75% екрана) задається інлайн — від актуальної висоти вікна.
    // М'яка об'ємна тінь навколо рамки — щоб біле вікно виділялось на тлі затемнення.
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  headerSpacer: {
    width: 36,
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 20,
    fontWeight: '800',
    color: '#1F2937',
  },
  closeButtonCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F3F4F6',
  },
  closeButtonIcon: {
    fontSize: 18,
    fontWeight: '700',
    color: '#4B5563',
  },

  pageInfoBlock: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
    borderRadius: 12,
    backgroundColor: '#F3F4F6',
    borderLeftWidth: 3,
    borderLeftColor: '#9CA3AF',
  },
  pageInfoHint: {
    fontSize: 11,
    fontWeight: '700',
    color: '#9CA3AF',
    marginBottom: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  pageInfoTitle: {
    fontSize: 14,
    color: '#374151',
    fontWeight: '600',
  },

  // Список не розтягує вікно (flexGrow: 0), але стискається й скролиться,
  // коли вміст не вміщається в maxHeight контейнера (flexShrink: 1).
  scrollArea: {
    flexGrow: 0,
    flexShrink: 1,
  },
  listContainer: {
    paddingBottom: 4,
  },

  rowWrapper: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E9E7E2',
    overflow: 'hidden',
  },
  rowWrapperLast: {
    borderBottomWidth: 0,
  },
  rowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    backgroundColor: '#FFFFFF',
  },
  iconWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
  },
  bookmarkIcon: {
    width: 12,
    height: 30,
  },
  textsColumn: {
    flex: 1,
    justifyContent: 'center',
  },
  bookmarkTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1F2937',
  },
  bookmarkSubtitle: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },

  emptyState: {
    paddingVertical: 28,
    alignItems: 'center',
  },
  emptyStateText: {
    fontSize: 14,
    color: '#9CA3AF',
    fontWeight: '500',
  },

  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E9E7E2',
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    backgroundColor: '#FFFFFF',
  },
  addRowDisabled: {
    opacity: 0.5,
  },
  addIconWrapper: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F3F4F6',
  },
  addIconText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#6B7280',
    lineHeight: 20,
  },
  addRowTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#374151',
  },
  addColorDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
});

export const localStyles = StyleSheet.create({
  swipeRowWrapper: {
    position: 'relative',
    overflow: 'hidden',
  },
  swipeDeleteBackground: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#DC2626',
  },
  swipeDeleteButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swipeDeleteButtonPressed: {
    backgroundColor: '#B91C1C',
  },
  swipeDeleteIcon: {
    width: 24,
    height: 24,
    tintColor: colors.white, // Фарбуємо іконку видалення у білий
  },
  rowContentPressedBg: {
    backgroundColor: '#F3F4F6',
  },
});
