let cachedIngAdjectives: Set<string> = new Set();

export function loadIngAdjectives(words: string[]): void {
  cachedIngAdjectives = new Set(words.map((w) => w.toLowerCase().trim()));
}

export function isIngAdjective(word: string): boolean {
  const normalizedWord = word.toLowerCase().trim();
  return normalizedWord.endsWith('ing') && cachedIngAdjectives.has(normalizedWord);
}

export function getIngAdjectivesCacheSize(): number {
  return cachedIngAdjectives.size;
}