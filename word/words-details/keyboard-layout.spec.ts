import { uaLayoutToEnglish } from './keyboard-layout';

describe('uaLayoutToEnglish (лише кандидат, не готове слово)', () => {
  it('забута розкладка: "фззду" → apple', () => {
    expect(uaLayoutToEnglish('фззду')).toBe('apple');
  });

  it('звичайне українське слово теж дає латиницю — тому кандидат треба перевіряти по словнику', () => {
    expect(uaLayoutToEnglish('машина часу')).toBe('vfibyf xfce');
  });

  it('літери, що стають розділовими знаками, — не кандидат', () => {
    expect(uaLayoutToEnglish('яблуко')).toBeNull();
  });
});
