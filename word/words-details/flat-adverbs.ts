/**
 * Слова, що бувають і прикметником, і прислівником без зміни форми:
 * "a hard day" (важкий) / "he trained hard" (старанно, наполегливо),
 * "a long road" / "long ago", "pretty girl" / "pretty good".
 * Для них у читалці значення обирається за реченням, навіть якщо в
 * словнику є лише одне з двох (друге створюється як додаткове значення).
 */
export const FLAT_ADVERBS = new Set<string>([
  'hard', 'fast', 'late', 'early', 'long', 'high', 'low', 'straight', 'wide', 'deep', 'close', 'far',
  'right', 'wrong', 'pretty', 'well', 'still', 'even', 'enough', 'daily', 'weekly', 'monthly', 'yearly',
  'free', 'loud', 'direct', 'fine', 'last', 'only', 'just', 'tight', 'clean', 'quick', 'slow', 'sharp',
  'flat', 'likely', 'alone', 'ahead', 'upstairs', 'downstairs', 'forward', 'backward', 'deadly', 'kindly',
  'sure', 'plain', 'dead', 'dear', 'cheap', 'fair', 'firm', 'short', 'solid', 'easy', 'loose', 'hourly',
  // іменник / прислівник: "walked home" — додому, "his home" — дім
  'home', 'back',
]);

/**
 * Омоніми іменник / прикметник з РІЗНИМ значенням: "kind" (вид / добрий),
 * "patient" (пацієнт / терплячий), "light" (світло / легкий). Якщо в
 * словнику є лише одне значення — друге пропонується, а вибір робиться
 * за реченням.
 */
export const NOUN_ADJECTIVE_HOMOGRAPHS = new Set<string>([
  'kind', 'patient', 'light', 'mean', 'fine', 'fair', 'present', 'right', 'close', 'sound', 'cool', 'novel',
  'minute', 'content', 'express', 'still', 'last', 'firm', 'plain', 'square', 'spare', 'safe', 'cross', 'dear',
  'gross', 'major', 'minor', 'chief', 'principal', 'private', 'secret', 'single', 'general', 'native', 'human',
  'individual', 'original', 'criminal', 'chemical', 'rare', 'left', 'average', 'blind', 'deaf', 'poor', 'rich',
  'dark', 'cold', 'flat', 'even', 'level', 'top', 'key', 'mint', 'pet', 'past', 'present', 'live', 'well',
]);

/**
 * Прислівники з FLAT_ADVERBS, які бувають ПІСЛЯ артикля, підсилюючи
 * наступний прикметник: "a pretty good idea", "a dead easy task",
 * "an even better plan", "a well known fact".
 */
export const ADVERBS_AFTER_DETERMINER = new Set<string>(['pretty', 'dead', 'even', 'well', 'plain', 'real']);

