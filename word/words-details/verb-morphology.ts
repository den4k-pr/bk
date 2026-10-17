/**
 * verb-morphology.ts
 *
 * Дві протилежні за напрямком, але однаково детерміновані задачі:
 *
 *   1. lemmatizeVerb(inflectedForm) -> baseForm
 *   2. conjugateVerb(baseForm) -> { pastForms: string[], participleForms: string[] }
 *
 * 🟢 РОЗШИРЕНО:
 * - Додано participleAlternates (аналог pastAlternates, але для дієприкметника
 *   минулого часу) — потрібно для пар типу get/got/gotten, де варіативність
 *   не в минулому часі, а саме в participle.
 * - conjugateVerb() тепер повертає participleForms: string[] замість
 *   одиночного participle: string — для симетрії з pastForms і щоб
 *   коректно віддавати ОБИДВІ форми там, де це потрібно (get -> got/gotten).
 * - Виправлено внутрішню непослідовність: у решти таблиці як основний
 *   варіант скрізь британський правопис (burnt/spelt/learnt/...), тому
 *   для "get" основною формою дієприкметника тепер теж є британське "got",
 *   а "gotten" (американське) — альтернатива, а не єдиний варіант.
 * - Додано ~40 поширених неправильних дієслів, яких бракувало
 *   (arise, awake, bear, beat, bid, cast, dwell, fit, grind, mistake,
 *   misunderstand, overthrow, undertake, upset, withhold, withstand тощо),
 *   а також розмовно-поширені альтернативні форми минулого часу
 *   (dove/dived, snuck/sneaked, shrunk/shrank, sprung/sprang).
 */

export interface IrregularVerbEntry {
  base: string;
  past: string;
  participle: string;
  /**
   * Додаткові валідні форми минулого часу, крім `past`.
   * Класичний приклад — "be" (was/were).
   */
  pastAlternates?: string[];
  /**
   * Додаткові валідні форми дієприкметника минулого часу, крім `participle`.
   * Приклад — "get" (got/gotten), "prove" (proved/proven).
   */
  participleAlternates?: string[];
}

export const IRREGULAR_VERBS: IrregularVerbEntry[] = [
  { base: 'arise', past: 'arose', participle: 'arisen' },
  { base: 'awake', past: 'awoke', participle: 'awoken' },
  { base: 'be', past: 'was', participle: 'been', pastAlternates: ['were'] },
  // "bear": born (народжений, пасивний стан) vs borne (нести/витримувати, активний стан)
  { base: 'bear', past: 'bore', participle: 'borne', participleAlternates: ['born'] },
  { base: 'beat', past: 'beat', participle: 'beaten' },
  { base: 'become', past: 'became', participle: 'become' },
  { base: 'begin', past: 'began', participle: 'begun' },
  { base: 'bend', past: 'bent', participle: 'bent' },
  { base: 'bet', past: 'bet', participle: 'bet' },
  // "bid" (пропонувати ціну на аукціоні) — bid/bid; архаїчне "наказувати" (bade/bidden) свідомо не додано — надто рідкісне/книжне
  { base: 'bid', past: 'bid', participle: 'bid' },
  { base: 'bind', past: 'bound', participle: 'bound' },
  { base: 'bite', past: 'bit', participle: 'bitten' },
  { base: 'bleed', past: 'bled', participle: 'bled' },
  { base: 'blow', past: 'blew', participle: 'blown' },
  { base: 'break', past: 'broke', participle: 'broken' },
  { base: 'breed', past: 'bred', participle: 'bred' },
  { base: 'bring', past: 'brought', participle: 'brought' },
  { base: 'broadcast', past: 'broadcast', participle: 'broadcast', pastAlternates: ['broadcasted'], participleAlternates: ['broadcasted'] },
  { base: 'build', past: 'built', participle: 'built' },
  { base: 'burn', past: 'burnt', participle: 'burnt', pastAlternates: ['burned'], participleAlternates: ['burned'] },
  { base: 'burst', past: 'burst', participle: 'burst' },
  { base: 'buy', past: 'bought', participle: 'bought' },
  { base: 'cast', past: 'cast', participle: 'cast' },
  { base: 'catch', past: 'caught', participle: 'caught' },
  { base: 'choose', past: 'chose', participle: 'chosen' },
  { base: 'cling', past: 'clung', participle: 'clung' },
  { base: 'come', past: 'came', participle: 'come' },
  { base: 'cost', past: 'cost', participle: 'cost' },
  { base: 'creep', past: 'crept', participle: 'crept' },
  { base: 'cut', past: 'cut', participle: 'cut' },
  { base: 'deal', past: 'dealt', participle: 'dealt' },
  { base: 'dig', past: 'dug', participle: 'dug' },
  // "dive": стандартна форма dived/dived, "dove" — поширений американський варіант минулого часу
  { base: 'dive', past: 'dived', participle: 'dived', pastAlternates: ['dove'] },
  { base: 'do', past: 'did', participle: 'done' },
  { base: 'draw', past: 'drew', participle: 'drawn' },
  // 🟢 ВИПРАВЛЕНО: узгоджено з рештою таблиці (британський варіант первинний),
  // усунуто конфлікт з костилем у word-generation.service.ts
  { base: 'dream', past: 'dreamt', participle: 'dreamt', pastAlternates: ['dreamed'], participleAlternates: ['dreamed'] },
  { base: 'drink', past: 'drank', participle: 'drunk' },
  { base: 'drive', past: 'drove', participle: 'driven' },
  { base: 'dwell', past: 'dwelt', participle: 'dwelt', pastAlternates: ['dwelled'], participleAlternates: ['dwelled'] },
  { base: 'eat', past: 'ate', participle: 'eaten' },
  { base: 'fall', past: 'fell', participle: 'fallen' },
  { base: 'feed', past: 'fed', participle: 'fed' },
  { base: 'feel', past: 'felt', participle: 'felt' },
  { base: 'fight', past: 'fought', participle: 'fought' },
  { base: 'find', past: 'found', participle: 'found' },
  // "fit": британське fitted/fitted первинне, американське fit/fit — альтернатива
  { base: 'fit', past: 'fitted', participle: 'fitted', pastAlternates: ['fit'], participleAlternates: ['fit'] },
  { base: 'flee', past: 'fled', participle: 'fled' },
  { base: 'fling', past: 'flung', participle: 'flung' },
  { base: 'fly', past: 'flew', participle: 'flown' },
  { base: 'forbid', past: 'forbade', participle: 'forbidden' },
  { base: 'forecast', past: 'forecast', participle: 'forecast', pastAlternates: ['forecasted'], participleAlternates: ['forecasted'] },
  { base: 'foresee', past: 'foresaw', participle: 'foreseen' },
  { base: 'forget', past: 'forgot', participle: 'forgotten' },
  { base: 'forgive', past: 'forgave', participle: 'forgiven' },
  { base: 'forgo', past: 'forwent', participle: 'forgone' },
  { base: 'forsake', past: 'forsook', participle: 'forsaken' },
  { base: 'freeze', past: 'froze', participle: 'frozen' },
  // 🟢 ВИПРАВЛЕНО: participle тепер "got" (первинно, за конвенцією таблиці),
  // "gotten" (американське) — альтернатива, а не єдина форма
  { base: 'get', past: 'got', participle: 'got', participleAlternates: ['gotten'] },
  { base: 'give', past: 'gave', participle: 'given' },
  { base: 'go', past: 'went', participle: 'gone' },
  { base: 'grind', past: 'ground', participle: 'ground' },
  { base: 'grow', past: 'grew', participle: 'grown' },
  { base: 'hang', past: 'hung', participle: 'hung' }, // "hanged/hanged" — лише для значення "стратити", інше слововживання
  { base: 'have', past: 'had', participle: 'had' },
  { base: 'hear', past: 'heard', participle: 'heard' },
  { base: 'hide', past: 'hid', participle: 'hidden' },
  { base: 'hit', past: 'hit', participle: 'hit' },
  { base: 'hold', past: 'held', participle: 'held' },
  { base: 'hurt', past: 'hurt', participle: 'hurt' },
  { base: 'keep', past: 'kept', participle: 'kept' },
  { base: 'kneel', past: 'knelt', participle: 'knelt', pastAlternates: ['kneeled'], participleAlternates: ['kneeled'] },
  { base: 'knit', past: 'knitted', participle: 'knitted', pastAlternates: ['knit'], participleAlternates: ['knit'] },
  { base: 'know', past: 'knew', participle: 'known' },
  { base: 'lay', past: 'laid', participle: 'laid' },
  { base: 'lead', past: 'led', participle: 'led' },
  { base: 'lean', past: 'leant', participle: 'leant', pastAlternates: ['leaned'], participleAlternates: ['leaned'] },
  { base: 'leap', past: 'leapt', participle: 'leapt', pastAlternates: ['leaped'], participleAlternates: ['leaped'] },
  { base: 'learn', past: 'learnt', participle: 'learnt', pastAlternates: ['learned'], participleAlternates: ['learned'] },
  { base: 'leave', past: 'left', participle: 'left' },
  { base: 'lend', past: 'lent', participle: 'lent' },
  { base: 'let', past: 'let', participle: 'let' },
  // "lie" — лягати/лежати (lay/lain). Омонім "lie" (брехати) — правильне дієслово (lied/lied), навмисно тут відсутній
  { base: 'lie', past: 'lay', participle: 'lain' },
  { base: 'light', past: 'lit', participle: 'lit', pastAlternates: ['lighted'], participleAlternates: ['lighted'] },
  { base: 'lose', past: 'lost', participle: 'lost' },
  { base: 'make', past: 'made', participle: 'made' },
  { base: 'mean', past: 'meant', participle: 'meant' },
  { base: 'meet', past: 'met', participle: 'met' },
  { base: 'mistake', past: 'mistook', participle: 'mistaken' },
  { base: 'misunderstand', past: 'misunderstood', participle: 'misunderstood' },
  { base: 'outdo', past: 'outdid', participle: 'outdone' },
  { base: 'overcome', past: 'overcame', participle: 'overcome' },
  { base: 'overdo', past: 'overdid', participle: 'overdone' },
  { base: 'overhear', past: 'overheard', participle: 'overheard' },
  { base: 'override', past: 'overrode', participle: 'overridden' },
  { base: 'overrun', past: 'overran', participle: 'overrun' },
  { base: 'oversee', past: 'oversaw', participle: 'overseen' },
  { base: 'oversleep', past: 'overslept', participle: 'overslept' },
  { base: 'overtake', past: 'overtook', participle: 'overtaken' },
  { base: 'overthrow', past: 'overthrew', participle: 'overthrown' },
  { base: 'partake', past: 'partook', participle: 'partaken' },
  { base: 'pay', past: 'paid', participle: 'paid' },
  // "prove" — правильне за past, але дієприкметник має 2 рівнозначні форми
  { base: 'prove', past: 'proved', participle: 'proved', participleAlternates: ['proven'] },
  { base: 'put', past: 'put', participle: 'put' },
  { base: 'quit', past: 'quit', participle: 'quit', pastAlternates: ['quitted'], participleAlternates: ['quitted'] },
  { base: 'read', past: 'read', participle: 'read' },
  { base: 'rebuild', past: 'rebuilt', participle: 'rebuilt' },
  { base: 'redo', past: 'redid', participle: 'redone' },
  { base: 'remake', past: 'remade', participle: 'remade' },
  { base: 'repay', past: 'repaid', participle: 'repaid' },
  { base: 'rid', past: 'rid', participle: 'rid' },
  { base: 'ride', past: 'rode', participle: 'ridden' },
  { base: 'ring', past: 'rang', participle: 'rung' },
  { base: 'rise', past: 'rose', participle: 'risen' },
  { base: 'run', past: 'ran', participle: 'run' },
  { base: 'say', past: 'said', participle: 'said' },
  { base: 'saw', past: 'sawed', participle: 'sawed', participleAlternates: ['sawn'] },
  { base: 'see', past: 'saw', participle: 'seen' },
  { base: 'seek', past: 'sought', participle: 'sought' },
  { base: 'sell', past: 'sold', participle: 'sold' },
  { base: 'send', past: 'sent', participle: 'sent' },
  { base: 'set', past: 'set', participle: 'set' },
  { base: 'shake', past: 'shook', participle: 'shaken' },
  { base: 'shave', past: 'shaved', participle: 'shaved', participleAlternates: ['shaven'] },
  { base: 'shear', past: 'sheared', participle: 'sheared', participleAlternates: ['shorn'] },
  { base: 'shed', past: 'shed', participle: 'shed' },
  { base: 'shine', past: 'shone', participle: 'shone', pastAlternates: ['shined'], participleAlternates: ['shined'] },
  { base: 'shoot', past: 'shot', participle: 'shot' },
  { base: 'show', past: 'showed', participle: 'shown', participleAlternates: ['showed'] },
  { base: 'shrink', past: 'shrank', participle: 'shrunk', pastAlternates: ['shrunk'] },
  { base: 'shut', past: 'shut', participle: 'shut' },
  { base: 'sing', past: 'sang', participle: 'sung' },
  { base: 'sink', past: 'sank', participle: 'sunk' },
  { base: 'sit', past: 'sat', participle: 'sat' },
  { base: 'sleep', past: 'slept', participle: 'slept' },
  { base: 'slide', past: 'slid', participle: 'slid' },
  { base: 'sling', past: 'slung', participle: 'slung' },
  { base: 'slink', past: 'slunk', participle: 'slunk' },
  { base: 'slit', past: 'slit', participle: 'slit' },
  { base: 'smell', past: 'smelt', participle: 'smelt', pastAlternates: ['smelled'], participleAlternates: ['smelled'] },
  // "sneak" — правильне stem, але американська розмовна форма "snuck" дуже поширена
  { base: 'sneak', past: 'sneaked', participle: 'sneaked', pastAlternates: ['snuck'], participleAlternates: ['snuck'] },
  { base: 'sow', past: 'sowed', participle: 'sowed', participleAlternates: ['sown'] },
  { base: 'speak', past: 'spoke', participle: 'spoken' },
  { base: 'speed', past: 'sped', participle: 'sped', pastAlternates: ['speeded'], participleAlternates: ['speeded'] },
  { base: 'spell', past: 'spelt', participle: 'spelt', pastAlternates: ['spelled'], participleAlternates: ['spelled'] },
  { base: 'spend', past: 'spent', participle: 'spent' },
  { base: 'spill', past: 'spilt', participle: 'spilt', pastAlternates: ['spilled'], participleAlternates: ['spilled'] },
  { base: 'spin', past: 'spun', participle: 'spun' },
  { base: 'spit', past: 'spat', participle: 'spat', pastAlternates: ['spit'], participleAlternates: ['spit'] },
  { base: 'split', past: 'split', participle: 'split' },
  { base: 'spoil', past: 'spoilt', participle: 'spoilt', pastAlternates: ['spoiled'], participleAlternates: ['spoiled'] },
  { base: 'spread', past: 'spread', participle: 'spread' },
  { base: 'spring', past: 'sprang', participle: 'sprung', pastAlternates: ['sprung'] },
  { base: 'stand', past: 'stood', participle: 'stood' },
  { base: 'steal', past: 'stole', participle: 'stolen' },
  { base: 'stick', past: 'stuck', participle: 'stuck' },
  { base: 'sting', past: 'stung', participle: 'stung' },
  { base: 'stink', past: 'stank', participle: 'stunk' },
  { base: 'stride', past: 'strode', participle: 'stridden' },
  { base: 'strike', past: 'struck', participle: 'struck' },
  { base: 'strive', past: 'strove', participle: 'striven', pastAlternates: ['strived'], participleAlternates: ['strived'] },
  { base: 'swear', past: 'swore', participle: 'sworn' },
  { base: 'sweep', past: 'swept', participle: 'swept' },
  { base: 'swell', past: 'swelled', participle: 'swollen', participleAlternates: ['swelled'] },
  { base: 'swim', past: 'swam', participle: 'swum' },
  { base: 'swing', past: 'swung', participle: 'swung' },
  { base: 'take', past: 'took', participle: 'taken' },
  { base: 'teach', past: 'taught', participle: 'taught' },
  { base: 'tear', past: 'tore', participle: 'torn' },
  { base: 'tell', past: 'told', participle: 'told' },
  { base: 'think', past: 'thought', participle: 'thought' },
  { base: 'throw', past: 'threw', participle: 'thrown' },
  { base: 'thrust', past: 'thrust', participle: 'thrust' },
  { base: 'tread', past: 'trod', participle: 'trodden', participleAlternates: ['trod'] },
  { base: 'undergo', past: 'underwent', participle: 'undergone' },
  { base: 'understand', past: 'understood', participle: 'understood' },
  { base: 'undertake', past: 'undertook', participle: 'undertaken' },
  { base: 'undo', past: 'undid', participle: 'undone' },
  { base: 'unwind', past: 'unwound', participle: 'unwound' },
  { base: 'uphold', past: 'upheld', participle: 'upheld' },
  { base: 'upset', past: 'upset', participle: 'upset' },
  { base: 'wake', past: 'woke', participle: 'woken' },
  { base: 'wear', past: 'wore', participle: 'worn' },
  { base: 'weave', past: 'wove', participle: 'woven' }, // "weave" (рухатись зиґзаґом) — правильне weaved/weaved, інше значення
  { base: 'weep', past: 'wept', participle: 'wept' },
  { base: 'wet', past: 'wet', participle: 'wet', pastAlternates: ['wetted'], participleAlternates: ['wetted'] },
  { base: 'win', past: 'won', participle: 'won' },
  { base: 'wind', past: 'wound', participle: 'wound' },
  { base: 'withdraw', past: 'withdrew', participle: 'withdrawn' },
  { base: 'withhold', past: 'withheld', participle: 'withheld' },
  { base: 'withstand', past: 'withstood', participle: 'withstood' },
  { base: 'write', past: 'wrote', participle: 'written' },
  // Неправильні дієслова, яких бракувало (без них "slain", "sewn", "strung"
  // не зводились до леми, а forms генерувались хибно: "slayed", "sewed").
  { base: 'befall', past: 'befell', participle: 'befallen' },
  { base: 'behold', past: 'beheld', participle: 'beheld' },
  { base: 'foretell', past: 'foretold', participle: 'foretold' },
  { base: 'hew', past: 'hewed', participle: 'hewn', participleAlternates: ['hewed'] },
  { base: 'mislay', past: 'mislaid', participle: 'mislaid' },
  { base: 'mislead', past: 'misled', participle: 'misled' },
  { base: 'mow', past: 'mowed', participle: 'mown', participleAlternates: ['mowed'] },
  { base: 'outgrow', past: 'outgrew', participle: 'outgrown' },
  { base: 'outrun', past: 'outran', participle: 'outrun' },
  { base: 'overeat', past: 'overate', participle: 'overeaten' },
  { base: 'overpay', past: 'overpaid', participle: 'overpaid' },
  { base: 'plead', past: 'pleaded', participle: 'pleaded', pastAlternates: ['pled'], participleAlternates: ['pled'] },
  { base: 'rethink', past: 'rethought', participle: 'rethought' },
  { base: 'retell', past: 'retold', participle: 'retold' },
  { base: 'rewrite', past: 'rewrote', participle: 'rewritten' },
  { base: 'sew', past: 'sewed', participle: 'sewn', participleAlternates: ['sewed'] },
  { base: 'slay', past: 'slew', participle: 'slain' },
  { base: 'smite', past: 'smote', participle: 'smitten' },
  { base: 'strew', past: 'strewed', participle: 'strewn', participleAlternates: ['strewed'] },
  { base: 'string', past: 'strung', participle: 'strung' },
  { base: 'thrive', past: 'thrived', participle: 'thrived', pastAlternates: ['throve'], participleAlternates: ['thriven'] },
  { base: 'wed', past: 'wed', participle: 'wed', pastAlternates: ['wedded'], participleAlternates: ['wedded'] },
  { base: 'wring', past: 'wrung', participle: 'wrung' },
];

const BY_BASE = new Map(IRREGULAR_VERBS.map(v => [v.base, v]));

// Зворотний індекс: будь-яка інфлексована форма -> базова.
// Реєструє past, participle і ВСІ їхні альтернативи окремими ключами.
const INFLECTED_TO_BASE = new Map<string, string>();
for (const v of IRREGULAR_VERBS) {
  INFLECTED_TO_BASE.set(v.past, v.base);
  INFLECTED_TO_BASE.set(v.participle, v.base);
  if (v.pastAlternates) {
    for (const alt of v.pastAlternates) {
      INFLECTED_TO_BASE.set(alt, v.base);
    }
  }
  if (v.participleAlternates) {
    for (const alt of v.participleAlternates) {
      INFLECTED_TO_BASE.set(alt, v.base);
    }
  }
}
// окремі форми 3-ї особи/герундія для найчастіших неправильних дієслів
INFLECTED_TO_BASE.set('is', 'be');
INFLECTED_TO_BASE.set('am', 'be');
INFLECTED_TO_BASE.set('are', 'be');
INFLECTED_TO_BASE.set('being', 'be');
INFLECTED_TO_BASE.set('has', 'have');
INFLECTED_TO_BASE.set('having', 'have');
INFLECTED_TO_BASE.set('does', 'do');
INFLECTED_TO_BASE.set('doing', 'do');
INFLECTED_TO_BASE.set('goes', 'go');
INFLECTED_TO_BASE.set('going', 'go');

function applyRegularLemmaRules(word: string): string {
  if (/[^aeiou]ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (/[^aeiou]ied$/.test(word)) return word.slice(0, -3) + 'y';
  if (/(ches|shes|xes|zzes|sses)$/.test(word)) return word.slice(0, -2);
  if (/ying$/.test(word) && word.length > 4) return word.slice(0, -4) + 'y';
  if (/ing$/.test(word) && word.length > 4) {
    let stem = word.slice(0, -3);
    if (/([bcdfgklmnprtvz])\1$/.test(stem)) {
      stem = stem.slice(0, -1);
    } else if (/[^aeiou][aeiou][bcdfgklmnprtvz]$/.test(stem) && !/e$/.test(stem)) {
      stem = stem + 'e';
    }
    return stem;
  }
  if (/ed$/.test(word) && word.length > 3) {
    let stem = word.slice(0, -2);
    if (/([bcdfgklmnprtvz])\1$/.test(stem)) {
      stem = stem.slice(0, -1);
    } else if (!/e$/.test(stem) && /[^aeiou][aeiou][bcdfgklmnprtvz]$/.test(stem)) {
      stem = stem + 'e';
    }
    return stem;
  }
  if (/[^s]s$/.test(word) && word.length > 3) return word.slice(0, -1);
  return word;
}

/** Приводить будь-яку форму дієслова до базової (інфінітив без "to"). */
export function lemmatizeVerb(word: string): string {
  const lower = word.toLowerCase();
  if (INFLECTED_TO_BASE.has(lower)) return INFLECTED_TO_BASE.get(lower)!;
  return applyRegularLemmaRules(lower);
}

function conjugateRegularVerb(base: string): [string, string] {
  let stem = base;

  if (/[^aeiou]y$/.test(stem)) {
    const form = stem.slice(0, -1) + 'ied';
    return [form, form];
  }
  if (/e$/.test(stem)) {
    const form = stem + 'd';
    return [form, form];
  }
  if (/^[^aeiou]*[aeiou][bcdfgklmnprtvz]$/.test(stem) && stem.length <= 5) {
    const form = stem + stem[stem.length - 1] + 'ed';
    return [form, form];
  }
  const form = stem + 'ed';
  return [form, form];
}

export interface ConjugationResult {
  /** Усі валідні форми минулого часу (зазвичай одна; для "be" — was/were). */
  pastForms: string[];
  /** Усі валідні форми дієприкметника минулого часу (зазвичай одна; для "get" — got/gotten). */
  participleForms: string[];
  isIrregular: boolean;
}

/**
 * Генерує форми минулого часу та дієприкметника для БАЗОВОЇ форми
 * дієслова — без AI.
 */
export function conjugateVerb(base: string): ConjugationResult {
  const lower = base.toLowerCase();
  const irregular = BY_BASE.get(lower);
  if (irregular) {
    return {
      pastForms: [irregular.past, ...(irregular.pastAlternates ?? [])],
      participleForms: [irregular.participle, ...(irregular.participleAlternates ?? [])],
      isIrregular: true,
    };
  }
  const [past, participle] = conjugateRegularVerb(lower);
  return { pastForms: [past], participleForms: [participle], isIrregular: false };
}

/** Чи є базова форма відомим (частим) дієсловом — використовується класифікатором. */
export function isKnownVerbBase(base: string): boolean {
  return BY_BASE.has(base.toLowerCase());
}