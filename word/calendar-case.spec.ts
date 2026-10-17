import { Word } from './word.entity';
import { WordCalendarCaseSubscriber } from './words-details/calendar-case.subscriber';
import { isCalendarNameEn, lowercaseCalendarNamesUk, normalizeCalendarCase } from './words-details/calendar-case.util';

describe('дні тижня й місяці в перекладі — з малої літери', () => {
  it.each([
    ['Monday', 'Понеділок', 'понеділок'],
    ['Friday', "П'ятниця", "п'ятниця"],
    ['Wednesday', 'Середа', 'середа'],
    ['January', 'Січень', 'січень'],
    ['May', 'Травень', 'травень'],
    ['March', 'Березень / марш', 'березень / марш'],
    ['on Monday', 'У Понеділок', 'У понеділок'],
  ])('%s: "%s" → "%s"', (text, translation, expected) => {
    const w = { text, translation, surfaceTranslations: null };
    normalizeCalendarCase(w);
    expect(w.translation).toBe(expected);
  });

  it('переклади форм теж зводяться', () => {
    const w = { text: 'Monday', translation: 'понеділок', surfaceTranslations: { 'v3|mondays': 'Понеділками' } };
    normalizeCalendarCase(w);
    expect(w.surfaceTranslations['v3|mondays']).toBe('понеділками');
  });

  it('інші слова не чіпаються (навіть з тими самими літерами)', () => {
    const w = { text: 'environment', translation: 'Середовище', surfaceTranslations: null };
    normalizeCalendarCase(w);
    expect(w.translation).toBe('Середовище');
    const name = { text: 'John', translation: 'Джон', surfaceTranslations: null };
    normalizeCalendarCase(name);
    expect(name.translation).toBe('Джон');
  });

  it('у перекладі дня інші слова з великої не змінюються', () => {
    expect(lowercaseCalendarNamesUk('Неділя (Великдень)')).toBe('неділя (Великдень)');
  });

  it('isCalendarNameEn', () => {
    expect(isCalendarNameEn('Sunday')).toBe(true);
    expect(isCalendarNameEn('sundays')).toBe(false);
    expect(isCalendarNameEn('monkey')).toBe(false);
    expect(isCalendarNameEn(undefined)).toBe(false);
  });

  it('Word: при читанні з бази і перед записом', () => {
    const sub = new WordCalendarCaseSubscriber();
    expect(sub.listenTo()).toBe(Word);
    const loaded = Object.assign(new Word(), { text: 'December', translation: 'Грудень' });
    sub.afterLoad(loaded);
    expect(loaded.translation).toBe('грудень');
    const inserted = Object.assign(new Word(), { text: 'Sunday', translation: 'Неділя' });
    sub.beforeInsert({ entity: inserted } as any);
    expect(inserted.translation).toBe('неділя');
    const updated = { text: 'July', translation: 'Липень' };
    sub.beforeUpdate({ entity: updated } as any);
    expect(updated.translation).toBe('липень');
  });
});
