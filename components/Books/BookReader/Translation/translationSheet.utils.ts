export const partOfSpeechMap: Record<string, string> = {
  noun: 'Іменник',
  verb: 'Дієслово',
  adjective: 'Прикметник',
  adverb: 'Прислівник',
  pronoun: 'Займенник',
  preposition: 'Прийменник',
  conjunction: 'Сполучник',
  interjection: 'Вигук',
  phrase: 'Фраза',
  idiom: 'Ідіома',
  phrasal_verb: 'Фразове дієслово',
  numeral: 'Числівник',
  modal_verb: 'Модальне дієслово'
};

// 🟢 Мікро-обробник для списків форм слова: якщо окремий елемент масиву
// forms сам містить кілька значень, розділених комою чи тире з пробілами
// навколо (наприклад "runs, running" або "runs - running"), розбиваємо
// його на окремі значення й склеюємо весь список однаковим текстовим
// роздільником " · ", а не комою чи дефісом.
export function normalizeFormsList(forms: string[]): string {
  return forms
    .flatMap(form => form.split(/\s*,\s*|\s+-\s+/g))
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .join(' · ');
}
