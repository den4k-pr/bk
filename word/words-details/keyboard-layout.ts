/**
 * Українська розкладка → англійська (ЙЦУКЕН → QWERTY): "фззду" → "apple".
 *
 * Це лише КАНДИДАТ. Будь-яке українське слово без б/ю/ж/х/ї/є теж дає
 * латиницю ("машина часу" → "vfibyf xfce"), тому результат можна приймати
 * тільки якщо таке англійське слово справді існує (див. виклики).
 */
const UA_TO_EN_LAYOUT: Record<string, string> = {
  'й': 'q', 'ц': 'w', 'у': 'e', 'к': 'r', 'е': 't', 'н': 'y', 'г': 'u', 'ш': 'i', 'щ': 'o', 'з': 'p', 'х': '[', 'ї': ']',
  'ф': 'a', 'і': 's', 'в': 'd', 'а': 'f', 'п': 'g', 'р': 'h', 'о': 'j', 'л': 'k', 'д': 'l', 'ж': ';', 'є': "'",
  'я': 'z', 'ч': 'x', 'с': 'c', 'м': 'v', 'и': 'b', 'т': 'n', 'ь': 'm', 'б': ',', 'ю': '.',
  'ґ': 'u', 'ы': 's', 'э': "'", 'ъ': ']',
};

/** Кандидат-переклад розкладки або null, якщо рядок не відображається в латиницю. */
export function uaLayoutToEnglish(text: string): string | null {
  const lower = text.toLowerCase().trim();
  if (!lower || !/^[а-яіїєґыэъь\s'-]+$/i.test(lower)) return null;

  let out = '';
  for (const ch of lower) {
    if (ch === ' ' || ch === '-' || ch === "'") {
      out += ch;
      continue;
    }
    const mapped = UA_TO_EN_LAYOUT[ch];
    if (!mapped) return null;
    out += mapped;
  }
  return /^[a-z][a-z\s'-]*$/.test(out) ? out : null;
}
