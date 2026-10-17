export interface IrregularNounEntry {
  singular: string;
  plural: string;
}

export const IRREGULAR_NOUNS: IrregularNounEntry[] = [
  { singular: 'child', plural: 'children' },
  { singular: 'man', plural: 'men' },
  { singular: 'woman', plural: 'women' },
  { singular: 'person', plural: 'people' },
  { singular: 'foot', plural: 'feet' },
  { singular: 'tooth', plural: 'teeth' },
  { singular: 'goose', plural: 'geese' },
  { singular: 'mouse', plural: 'mice' },
  { singular: 'louse', plural: 'lice' },
  { singular: 'ox', plural: 'oxen' },
  { singular: 'die', plural: 'dice' },
  { singular: 'cactus', plural: 'cacti' },
  { singular: 'focus', plural: 'foci' },
  { singular: 'fungus', plural: 'fungi' },
  { singular: 'nucleus', plural: 'nuclei' },
  { singular: 'syllabus', plural: 'syllabi' },
  { singular: 'analysis', plural: 'analyses' },
  { singular: 'axis', plural: 'axes' },
  { singular: 'basis', plural: 'bases' },
  { singular: 'crisis', plural: 'crises' },
  { singular: 'diagnosis', plural: 'diagnoses' },
  { singular: 'ellipsis', plural: 'ellipses' },
  { singular: 'hypothesis', plural: 'hypotheses' },
  { singular: 'oasis', plural: 'oases' },
  { singular: 'parenthesis', plural: 'parentheses' },
  { singular: 'thesis', plural: 'theses' },
  { singular: 'appendix', plural: 'appendices' },
  { singular: 'index', plural: 'indices' },
  { singular: 'matrix', plural: 'matrices' },
  { singular: 'phenomenon', plural: 'phenomena' },
  { singular: 'criterion', plural: 'criteria' },
  { singular: 'datum', plural: 'data' },
  { singular: 'curriculum', plural: 'curricula' },
  { singular: 'bacterium', plural: 'bacteria' },
  { singular: 'medium', plural: 'media' },
  { singular: 'memorandum', plural: 'memoranda' },
  { singular: 'leaf', plural: 'leaves' },
  { singular: 'loaf', plural: 'loaves' },
  { singular: 'knife', plural: 'knives' },
  { singular: 'life', plural: 'lives' },
  { singular: 'wife', plural: 'wives' },
  { singular: 'wolf', plural: 'wolves' },
  { singular: 'shelf', plural: 'shelves' },
  { singular: 'half', plural: 'halves' },
  { singular: 'calf', plural: 'calves' },
  { singular: 'elf', plural: 'elves' },
  { singular: 'scarf', plural: 'scarves' },
  { singular: 'thief', plural: 'thieves' },
  { singular: 'sheep', plural: 'sheep' },
  { singular: 'deer', plural: 'deer' },
  { singular: 'fish', plural: 'fish' },
  { singular: 'species', plural: 'species' },
  { singular: 'series', plural: 'series' },
  { singular: 'aircraft', plural: 'aircraft' },
];

const PLURAL_TO_SINGULAR = new Map<string, string>();
for (const entry of IRREGULAR_NOUNS) {
  PLURAL_TO_SINGULAR.set(entry.plural, entry.singular);
}

function applyRegularPluralStrippingRules(word: string): string {
  if (/[^aeiou]ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (/(ches|shes|xes|zzes|sses)$/.test(word)) return word.slice(0, -2);
  if (/[^s]s$/.test(word) && word.length > 3) return word.slice(0, -1);
  return word;
}

export function lemmatizeNoun(word: string): string {
  const lower = word.toLowerCase().trim();
  if (PLURAL_TO_SINGULAR.has(lower)) return PLURAL_TO_SINGULAR.get(lower)!;
  return applyRegularPluralStrippingRules(lower);
}