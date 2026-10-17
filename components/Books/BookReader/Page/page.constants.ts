export const PARAGRAPH_WINDOW_BUFFER_MULTIPLIER = 3;
export const DEFAULT_VIEWPORT_HEIGHT_GUESS = 800;
export const CONTAINER_PADDING_TOP = 15;
// Горизонтальний відступ контейнера тексту — має збігатися з paddingHorizontal
// внутрішнього <View> у рендері. Потрібен, щоб обчислити X слова у вікні.
export const CONTAINER_PADDING_LEFT = 4;
export const CYRILLIC_TEST = /[а-яА-ЯіїєґІЇЄҐ]/;
export const LETTER_TEST = /[a-zA-Zа-яіїєґА-ЯІЇЄҐ]/;
export const WHITESPACE_TEST = /^\s+$/;
export const NEWLINE_TEST = /\n/;
