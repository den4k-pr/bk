import { colors } from '../styles/theme';
import { BookLevel, LevelConfig, BookItem } from '../types/books';

export const LEVEL_COLORS: Record<BookLevel, LevelConfig> = {
  'A1-A2': { main: '#4CAF50', bg: colors.successSoft, text: '#2E7D32', label: 'Зелений (Базовий)' },
  'B1': { main: '#FFB74D', bg: '#FFF3E0', text: '#EF6C00', label: 'Жовтий (Середній)' },
  'B2': { main: '#FF9800', bg: '#FFF3E0', text: '#E65100', label: 'Помаранчевий (Вище середнього)' },
  'C1-C2': { main: '#F44336', bg: '#FFEBEE', text: '#C62828', label: 'Червоний (Просунутий)' },
};

export const BOOKS_DATA: BookItem[] = [
  {
    id: '1',
    title: 'Англійська по-простому',
    subtitle: 'Для початківців',
    level: 'B1',
    progress: 12,
    chapters: ['Вступ та знайомство', 'Частина 1: Перші кроки', 'Чому люди стресують?', 'Розмовна практика', 'Граматичний інтенсив'],
  },
  {
    id: '2',
    title: 'Як подолати неспокій та почати жити',
    subtitle: 'Психологія та адаптація',
    level: 'A1-A2',
    progress: 99,
    chapters: ['Вступ', 'Частина 1', 'Аналіз страхів', 'Практичні вправи'],
  },
  {
    id: '3',
    title: '1000 Слів для виживання',
    subtitle: 'Лексичний максимум',
    level: 'C1-C2',
    progress: 7,
    chapters: ['Професійний сленг', 'Ідіоми', 'Фразові дієслова'],
  },
];