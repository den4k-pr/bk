import { colors } from '../../../styles/theme';
import { StyleSheet, Platform } from 'react-native';
import { FONT_SIZE } from '../../../lists/fontSizes';

export const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    backgroundColor: colors.white,
  },
  // Хедер (залишено без змін за вашим запитом)
  header: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    paddingHorizontal: 10, 
    paddingVertical: 10,
    backgroundColor: colors.neutral,
    borderBottomWidth: 1,
    borderBottomColor: '#E2ECE9',
  },
  iconButton: { 
    width: 40, 
    height: 40,
    justifyContent: "center",
    alignItems: "center"
  },
  iconButton_img: {
    width: 20,
    height: 20,
  },
  // Стрілка назад — того ж розміру, що й у читалці (30×30).
  backButton_img: {
    width: 30,
    height: 30,
  },
  buttonActive: {
    opacity: 0.7,
    transform: [{ scale: 0.95 }]
  },
  headerTitle: { 
    fontSize: FONT_SIZE.mini, 
    fontWeight: '700', 
    color: '#0F172A', 
    flex: 1, 
    textAlign: 'center',
    marginHorizontal: 12,
  },
  scrollContent: { 
    paddingBottom: 40 
  },
  // Постер Секція (оновлено під скріншот)
  posterSection: { 
    width: '100%',
    paddingBottom: 15
  },
  imageWrapper: { 
    width: '100%', 
    height: 200,
    borderRadius: 3,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: colors.black, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 5 },
      android: { elevation: 8 }
    }),
  },
  posterImage: { 
    width: '100%', 
    height: '100%',
  },
  posterOverlay: {
    flex: 1,
     // Легке затемнення поверхні
    justifyContent: 'space-between',
  },

  posterOverlay_top: {
    padding: 15,
    backgroundColor: 'rgba(0, 0, 0, 0.42)',
    

  },
  posterTextOnImage: {
    fontSize: 22,
    fontWeight: 'bold',
    color: colors.white,
    textAlign: 'center',
    marginTop: 0,
  },
  posterFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: "auto",
    padding: 15
  },
  progressText: { 
    fontSize: FONT_SIZE.preLarge +5, 
    fontWeight: 'bold', 
    color: '#F9A825', // Помаранчевий колір для 8%
    position: "absolute",
    left: 10,
    bottom: 10
  },
  continueButton: {
    backgroundColor: '#F9A825',
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 5,
    marginHorizontal: "auto"
  },
  continueButtonActive: {
    backgroundColor: 'rgba(255, 255, 255, 1)',
  },
  continueButtonText: {
    fontSize: FONT_SIZE.medium,
    fontWeight: '600',
    color: colors.black,
  },

  // Зміст (оновлено під скріншот)
  chaptersContainer: { 
    paddingHorizontal: 15,
    marginTop: 10,
  },
  chapterCard: { 
    flexDirection: 'row', 
    alignItems: 'center',
    gap: 15, 
    marginBottom: 15,
  },
  chapterImage: { 
    width: 80, 
    height: 80, 
    borderRadius: 3,
    marginRight: 1, 
  },
  chapterInfo: {
    flex: 1,
    height: 80,
    justifyContent: 'center',
  },
  chapterName: { 
    fontSize: 16, 
    fontWeight: 'bold', 
    paddingRight: 15,
    color: colors.black,
    marginBottom: 5,
  },
  readAction: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionText: {
    fontSize: FONT_SIZE.preMini,
    fontWeight: '600',
    color: '#00C853', // Зелений колір "Читати"
    marginRight: 5,
  },
  arrowIcon: {
    width: 16,
    height: 16,
    tintColor: '#00C853',
    transform: [{rotate: "180deg"}]
  },
});