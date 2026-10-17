/**
 * Дні тижня й місяці в українській пишуться з малої літери. Для слів
 * "Monday", "January" тощо переклад зводиться до нижнього регістру —
 * і для нових записів, і для вже збережених у базі (при читанні).
 * Решта перекладу не змінюється.
 */
const CALENDAR_NAMES_EN = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
]);

const CALENDAR_STEM_UK =
  /^(понеділ|вівтор|серед|четвер|п['’ʼ]?ятниц|субот|неділ|січ|лют|берез|квіт|трав|черв|лип|серп|верес|жовт|листопад|груд)/;

const CAPITALIZED_UK_WORD = /[А-ЯІЇЄҐ][а-яіїєґА-ЯІЇЄҐ'’ʼ-]*/g;

export function isCalendarNameEn(text: string | null | undefined): boolean {
  if (!text) return false;
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .some((token) => CALENDAR_NAMES_EN.has(token));
}

/** Назви днів / місяців у перекладі — з малої; інші слова без змін. */
export function lowercaseCalendarNamesUk(value: string): string {
  if (!value) return value;
  return value.replace(CAPITALIZED_UK_WORD, (word) => {
    const lower = word.toLowerCase();
    return CALENDAR_STEM_UK.test(lower) ? lower : word;
  });
}

/** Переклад і переклади форм слова-дня/місяця — з малої (на місці). */
export function normalizeCalendarCase(word: {
  text?: string | null;
  translation?: string | null;
  surfaceTranslations?: Record<string, string> | null;
}): void {
  if (!isCalendarNameEn(word.text)) return;
  if (typeof word.translation === 'string') {
    word.translation = lowercaseCalendarNamesUk(word.translation);
  }
  const surface = word.surfaceTranslations;
  if (surface && typeof surface === 'object') {
    for (const key of Object.keys(surface)) {
      if (typeof surface[key] === 'string') surface[key] = lowercaseCalendarNamesUk(surface[key]);
    }
  }
}
