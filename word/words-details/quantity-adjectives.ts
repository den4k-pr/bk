export interface QuantityAdjectiveEntry {
  base: string;
  comparative: string[];
  superlative: string[];
}

const QUANTITY_ADJECTIVES: QuantityAdjectiveEntry[] = [
  { base: 'many', comparative: ['more'], superlative: ['most'] },
  { base: 'much', comparative: ['more'], superlative: ['most'] },
  { base: 'some', comparative: ['more'], superlative: ['most'] },
  { base: 'little', comparative: ['less', 'lesser'], superlative: ['least'] },
  { base: 'few', comparative: ['fewer'], superlative: ['fewest'] },
  { base: 'good', comparative: ['better'], superlative: ['best'] },
  { base: 'well', comparative: ['better'], superlative: ['best'] },
  { base: 'bad', comparative: ['worse'], superlative: ['worst'] },
  { base: 'ill', comparative: ['worse'], superlative: ['worst'] },
  { base: 'far', comparative: ['farther', 'further'], superlative: ['farthest', 'furthest'] },
  // Суплетивні форми, що в сучасній мові є ОКРЕМИМИ словами, тут свідомо
  // відсутні: elder/eldest (≠ old), latter/last (≠ late), next (≠ nigh),
  // former/first/foremost (≠ fore), inner/outer/upper. Раніше "first"
  // перекладався як "fore" (передній), а "last" — як форма "late".
  { base: 'old', comparative: ['older'], superlative: ['oldest'] },
  { base: 'late', comparative: ['later'], superlative: ['latest'] },
];

// Перший запис перемагає: "better"/"best" — форми "good" (а не "well",
// який у таблиці нижче і раніше перезаписував good).
const QUANTITY_ADJECTIVE_LOOKUP = new Map<string, QuantityAdjectiveEntry>();
const register = (key: string, entry: QuantityAdjectiveEntry) => {
  if (!QUANTITY_ADJECTIVE_LOOKUP.has(key)) QUANTITY_ADJECTIVE_LOOKUP.set(key, entry);
};
for (const entry of QUANTITY_ADJECTIVES) register(entry.base, entry);
for (const entry of QUANTITY_ADJECTIVES) {
  for (const c of entry.comparative) register(c, entry);
  for (const s of entry.superlative) register(s, entry);
}

export function resolveQuantityAdjective(word: string): QuantityAdjectiveEntry | null {
  return QUANTITY_ADJECTIVE_LOOKUP.get(word.toLowerCase().trim()) ?? null;
}