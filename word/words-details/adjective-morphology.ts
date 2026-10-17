/**
 * adjective-morphology.ts
 *
 * Генерація comparative/superlative форм БЕЗ AI.
 * Правила англійської граматики тут достатньо чіткі, щоб формалізувати:
 *
 *   1. Неправильні форми — фіксована, закрита таблиця.
 *   2. Односкладові слова -> -er/-est.
 *   3. Двоскладові на -y -> -ier/-iest.
 *   4. Двоскладові на -ow/-le/-some/-et/-on (типово беруть -er/-est).
 *   5. Решта (3+ складів, або 2 склади без вищезгаданих закінчень) -> more/most.
 *   6. Слова без ступенів порівняння (абсолютні, класифікаційні прикметники).
 *
 * Для екзотичних/рідкісних слів функція повертає ambiguous: true.
 *
 * 🟢 ВАЖЛИВО ПРО МЕХАНІКУ БЕЗПЕКИ:
 * NO_DEGREE_WORDS перевіряється ПЕРШИМ, до будь-якого підрахунку складів
 * чи застосування суфіксних правил. Це означає, що для 3+ складових слів
 * і для 2-складових слів, що НЕ підпадають під жоден із патернів
 * TWO_SYLLABLE_ER_EST_ENDINGS, система і без явного включення в
 * NO_DEGREE_WORDS ніколи не згенерує неіснуюче слово — вона просто впаде
 * у безпечну гілку "more/most" (ambiguous: true).
 *
 * РЕАЛЬНА ЗОНА РИЗИКУ — це слова, які ЗАВЖДИ отримують суфікс -er/-est
 * автоматично, без жодного запобіжника:
 *   а) БУДЬ-ЯКЕ односкладове слово (гілка "syllables === 1");
 *   б) БУДЬ-ЯКЕ двоскладове слово, що закінчується на -y, -ow, -le,
 *      -some, -et або -on (навіть якщо це не суфікс ступеня порівняння,
 *      а частина кореня — як було з "other", що закінчується на "er"-подібний
 *      шаблон, або як зараз з національностями "French", "Dutch", "Welsh",
 *      "Roman", що короткі й/або закінчуються на "-on").
 *
 * Саме тому нижче явно перераховані category-за-category ВСІ практично
 * вживані нон-градуальні (non-gradable/absolute) прикметники англійської
 * мови — з особливим фокусом на короткі (1-2 склади) слова, бо саме вони
 * найнебезпечніші. Повністю вичерпний список у принципі неможливий (клас
 * теоретично відкритий — нові національності/матеріали/терміни виникають),
 * але це максимально широке практичне покриття.
 */

export interface IrregularAdjEntry {
  base: string;
  comparative: string;
  superlative: string;
}

// Максимально розширений список неправильних та специфічних прикметників
export const IRREGULAR_ADJECTIVES: IrregularAdjEntry[] = [
  { base: 'good', comparative: 'better', superlative: 'best' },
  { base: 'well', comparative: 'better', superlative: 'best' },
  { base: 'bad', comparative: 'worse', superlative: 'worst' },
  { base: 'ill', comparative: 'worse', superlative: 'worst' },
  { base: 'far', comparative: 'farther / further', superlative: 'farthest / furthest' },
  { base: 'little', comparative: 'less / lesser', superlative: 'least' },
  { base: 'much', comparative: 'more', superlative: 'most' },
  { base: 'many', comparative: 'more', superlative: 'most' },
  { base: 'some', comparative: 'more', superlative: 'most' },
  { base: 'old', comparative: 'older / elder', superlative: 'oldest / eldest' },
  { base: 'late', comparative: 'later / latter', superlative: 'latest / last' },
  { base: 'nigh', comparative: 'nigher', superlative: 'nighest / next' },
  { base: 'fore', comparative: 'former', superlative: 'foremost / first' },
  { base: 'hind', comparative: 'hinder', superlative: 'hindmost / hindermost' },
  { base: 'inner', comparative: 'inner', superlative: 'inmost / innermost' }, // Часто не має comparative, але якщо є, то співпадає з base
  { base: 'outer', comparative: 'outer', superlative: 'outmost / outermost' },
  { base: 'upper', comparative: 'upper', superlative: 'upmost / uppermost' },
];

const BY_BASE = new Map(IRREGULAR_ADJECTIVES.map(a => [a.base, a]));

/**
 * Прикметники, що семантично не мають ступенів порівняння (Non-gradable / Absolute adjectives).
 * Включає: абсолютні стани, геометричні фігури, матеріали, наукові/технічні класифікатори,
 * географічні напрямки, часові цикли, бінарні стани, національності/походження,
 * визначальні/порядкові слова та граничні (extreme) прикметники.
 */
const NO_DEGREE_WORDS = new Set([
  // ─────────────────────────────────────────────────────────────────
  // 1. АБСОЛЮТНІ СТАНИ ТА ЯКОСТІ (100% або 0% наявності ознаки)
  // ─────────────────────────────────────────────────────────────────
  'perfect', 'unique', 'impossible', 'infinite', 'eternal', 'absolute', 'complete',
  'empty', 'full', 'universal', 'unanimous', 'final', 'fatal', 'supreme', 'ultimate',
  'total', 'entire', 'correct', 'wrong', 'true', 'false', 'right', 'main', 'chief',
  'principal', 'essential', 'fundamental', 'paramount', 'ideal', 'identical',
  'immortal', 'maximum', 'minimum', 'optimum', 'primary', 'sole', 'solitary',
  'stationary', 'unavoidable', 'unbroken', 'uniform', 'unknown', 'unlimited',
  'void', 'whole', 'null', 'definitive', 'flawless', 'faultless', 'impeccable',
  'inevitable', 'irreversible', 'permanent', 'temporary', 'exact', 'precise',
  'irrevocable', 'irreparable', 'irreplaceable', 'irretrievable', 'undeniable',
  'unquestionable', 'indisputable', 'incontrovertible', 'unmistakable',
  'undisputed', 'uncontested', 'unopposed', 'unrivalled', 'unrivaled',
  'unparalleled', 'unequalled', 'unequaled', 'matchless', 'peerless',
  'incomparable', 'inimitable', 'singular', 'unanswerable', 'irrefutable',
  'undeniable', 'conclusive', 'terminal', 'inescapable', 'certain',

  // ─────────────────────────────────────────────────────────────────
  // 1b. ВИЗНАЧАЛЬНІ / ПОРЯДКОВІ / КВАНТОРНІ ПРИКМЕТНИКИ
  //     (типово короткі — 1 склад — тому особливо небезпечні без цього списку)
  // ─────────────────────────────────────────────────────────────────
  'other', 'either', 'neither', 'same', 'such', 'own', 'mere', 'sheer', 'utter',
  'next', 'last', 'first', 'only', 'prime', 'single', 'double', 'triple',
  'quadruple', 'dual', 'twin', 'joint', 'mutual', 'reciprocal', 'previous',
  'prior', 'subsequent', 'former', 'latter', 'initial', 'original', 'alternate',
  'alternative', 'given', 'set', 'fixed', 'due', 'sundry', 'various', 'certain',
  'respective', 'said', 'aforementioned', 'aforesaid',

  // ─────────────────────────────────────────────────────────────────
  // 2. БІНАРНІ ТА ФІЗИЧНІ СТАНИ (Люди, тварини, об'єкти)
  // ─────────────────────────────────────────────────────────────────
  'dead', 'alive', 'asleep', 'awake', 'blind', 'deaf', 'mute', 'married', 'pregnant',
  'single', 'divorced', 'widowed', 'engaged', 'male', 'female', 'mortal', 'extinct',
  'destroyed', 'devoid', 'virgin', 'orphan', 'sober', 'sterile', 'immune',
  'paralyzed', 'conscious', 'unconscious', 'guilty', 'innocent', 'bankrupt',
  'legal', 'illegal', 'legitimate', 'illegitimate', 'valid', 'invalid', 'genuine',
  'fake', 'artificial', 'man-made', 'deceased', 'born', 'unborn', 'adult',
  'juvenile', 'infant', 'newborn', 'stillborn', 'unemployed', 'employed',
  'retired', 'disabled', 'literate', 'illiterate', 'vacant', 'occupied',

  // ─────────────────────────────────────────────────────────────────
  // 3. ГЕОМЕТРІЯ, ФОРМИ ТА МАТЕМАТИКА
  // ─────────────────────────────────────────────────────────────────
  'square', 'round', 'equal', 'circular', 'cubic', 'cylindrical', 'diagonal',
  'hexagonal', 'octagonal', 'pentagonal', 'oval', 'parallel', 'perpendicular',
  'rectangular', 'spherical', 'straight', 'triangular', 'horizontal', 'vertical',
  'binary', 'mathematical', 'geometric', 'algebraic', 'quadratic', 'quadrilateral',
  'decimal', 'metric', 'linear', 'orthogonal', 'symmetrical', 'asymmetrical',
  'proportionate', 'spatial', 'planar', 'concentric', 'convex', 'concave',
  'conical', 'pyramidal', 'elliptical', 'polygonal', 'prismatic', 'tangential',
  'even', 'odd', 'prime', 'positive', 'negative', 'exponential', 'logarithmic',

  // ─────────────────────────────────────────────────────────────────
  // 4. ЧАС, ЧАСТОТА ТА ЦИКЛІЧНІСТЬ
  // ─────────────────────────────────────────────────────────────────
  'daily', 'weekly', 'monthly', 'yearly', 'annual', 'hourly', 'nightly',
  'biennial', 'perennial', 'chronological', 'continuous', 'periodic', 'terminal',
  'synchronous', 'asynchronous', 'preliminary', 'prior', 'subsequent',
  'simultaneous', 'past', 'present', 'future', 'nocturnal', 'diurnal',
  'biannual', 'biweekly', 'bimonthly', 'quarterly', 'decennial', 'centennial',
  'millennial', 'seasonal', 'momentary', 'instantaneous', 'perpetual',
  'everlasting', 'timeless', 'immediate', 'concurrent', 'consecutive',
  'sequential', 'recurrent', 'punctual', 'overdue',

  // ─────────────────────────────────────────────────────────────────
  // 5. МАТЕРІАЛИ ТА СКЛАД (Класифікаційні)
  // ─────────────────────────────────────────────────────────────────
  'wooden', 'metallic', 'plastic', 'golden', 'synthetic', 'organic', 'iron',
  'steel', 'silver', 'glass', 'ceramic', 'leather', 'cotton', 'woolen', 'silk',
  'paper', 'stone', 'marble', 'concrete', 'rubber', 'bronze', 'copper',
  'aluminum', 'titanium', 'fabric', 'brass', 'nylon', 'polyester', 'linen',
  'granite', 'porcelain', 'crystal', 'platinum', 'timber', 'canvas',
  'cardboard', 'plywood', 'velvet', 'denim', 'tweed', 'corduroy', 'suede',
  'ivory', 'wax', 'clay', 'cork', 'felt', 'foam', 'gauze', 'gravel',
  'inorganic', 'chrome', 'stainless',

  // ─────────────────────────────────────────────────────────────────
  // 6. ГЕОГРАФІЯ, НАПРЯМКИ ТА МАСШТАБ
  // ─────────────────────────────────────────────────────────────────
  'northern', 'southern', 'eastern', 'western', 'polar', 'equatorial', 'global',
  'international', 'national', 'local', 'regional', 'domestic', 'internal',
  'external', 'interior', 'exterior', 'urban', 'rural', 'planetary', 'lunar',
  'solar', 'astronomical', 'geographical', 'geological', 'oceanic', 'earthly',
  'terrestrial', 'celestial', 'maritime', 'alpine', 'coastal', 'continental',
  'suburban', 'civic', 'provincial', 'municipal', 'cosmic', 'arctic',
  'tropical', 'subtropical', 'hemispheric', 'transcontinental',
  'intercontinental', 'worldwide', 'nationwide', 'statewide', 'citywide',
  'offshore', 'onshore', 'overseas', 'underground', 'underwater', 'aerial',
  'atmospheric', 'upstream', 'downstream', 'inland', 'overland',

  // ─────────────────────────────────────────────────────────────────
  // 6b. НАЦІОНАЛЬНОСТІ, ЕТНІЧНА ПРИНАЛЕЖНІСТЬ ТА ПОХОДЖЕННЯ
  //     (класифікаційні прикметники за визначенням не мають ступенів
  //     порівняння; особливо небезпечні короткі/на "-on","-an" форми)
  // ─────────────────────────────────────────────────────────────────
  'american', 'british', 'english', 'french', 'german', 'dutch', 'welsh',
  'scottish', 'irish', 'swiss', 'swedish', 'norwegian', 'danish', 'finnish',
  'polish', 'russian', 'ukrainian', 'belarusian', 'czech', 'slovak',
  'hungarian', 'romanian', 'bulgarian', 'serbian', 'croatian', 'slovenian',
  'greek', 'turkish', 'italian', 'spanish', 'portuguese', 'austrian',
  'belgian', 'chinese', 'japanese', 'korean', 'vietnamese', 'thai',
  'indian', 'pakistani', 'bangladeshi', 'nepalese', 'indonesian',
  'malaysian', 'filipino', 'singaporean', 'mongolian', 'persian', 'iranian',
  'iraqi', 'syrian', 'lebanese', 'israeli', 'jewish', 'palestinian',
  'saudi', 'emirati', 'egyptian', 'moroccan', 'algerian', 'tunisian',
  'nigerian', 'kenyan', 'ethiopian', 'ghanaian', 'african', 'european',
  'asian', 'australian', 'canadian', 'mexican', 'brazilian', 'argentine',
  'chilean', 'peruvian', 'colombian', 'venezuelan', 'cuban', 'jamaican',
  'roman', 'latin', 'nordic', 'slavic', 'anglo', 'arab', 'hispanic',
  'caucasian',

  // ─────────────────────────────────────────────────────────────────
  // 7. НАУКОВІ, МЕДИЧНІ ТА ТЕХНІЧНІ КЛАСИФІКАТОРИ
  // ─────────────────────────────────────────────────────────────────
  'acoustic', 'atomic', 'biological', 'bovine', 'canine', 'cardiovascular',
  'chemical', 'civil', 'clinical', 'congenital', 'constitutional', 'criminal',
  'dental', 'digital', 'diplomatic', 'ecological', 'economic', 'educational',
  'electrical', 'electromagnetic', 'electronic', 'environmental', 'ethical',
  'feline', 'financial', 'floral', 'gastric', 'genetic', 'historical',
  'ideological', 'institutional', 'intellectual', 'joint', 'judicial', 'legal',
  'legislative', 'linguistic', 'literal', 'magnetic', 'manual', 'marginal',
  'maternal', 'medical', 'mental', 'musical', 'mutual', 'naval', 'nuclear',
  'occupational', 'optical', 'oral', 'parental', 'paternal', 'physical',
  'political', 'psychological', 'public', 'racial', 'religious', 'scientific',
  'secondary', 'semantic', 'senior', 'junior', 'statistical', 'structural',
  'surgical', 'symbolic', 'technical', 'technological', 'theoretical', 'toxic',
  'verbal', 'viral', 'visual', 'vocal', 'botanical', 'neurological', 'psychiatric',
  'pediatric', 'pulmonary', 'respiratory', 'skeletal', 'muscular', 'cellular',
  'molecular', 'hormonal', 'immunological', 'orthopedic', 'dermatological',
  'cardiac', 'hepatic', 'renal', 'spinal', 'cranial', 'thoracic', 'abdominal',
  'hematological', 'endocrine', 'gastrointestinal', 'ophthalmic', 'obstetric',
  'gynecological', 'pharmaceutical', 'radiological', 'anatomical',
  'physiological', 'embryonic', 'fetal', 'prenatal', 'postnatal', 'bacterial',
  'fungal', 'microbial', 'diabetic', 'epileptic', 'chronic', 'acute',
  'benign', 'malignant', 'terminal',

  // ─────────────────────────────────────────────────────────────────
  // 8. ГРАНИЧНІ СТАНИ (Extreme Adjectives — вже містять значення "very/most")
  //    Їх не використовують з -er/-est, а лише з підсилювачами типу "absolutely"
  // ─────────────────────────────────────────────────────────────────
  'freezing', 'boiling', 'scalding', 'furious', 'starving', 'exhausted',
  'terrified', 'petrified', 'devastated', 'huge', 'tiny', 'gigantic',
  'microscopic', 'awful', 'excellent', 'fantastic', 'horrible', 'terrible',
  'delicious', 'disgusting', 'fascinating', 'hilarious', 'gorgeous', 'hideous',
  'spotless', 'filthy', 'brilliant', 'astounding', 'breathtaking',
  'mind-boggling', 'enormous', 'immense', 'colossal', 'minuscule', 'ecstatic',
  'delighted', 'thrilled', 'superb', 'magnificent', 'marvelous', 'marvellous',
  'stunning', 'phenomenal', 'incredible', 'unbelievable', 'outstanding',
  'exceptional', 'extraordinary', 'spectacular', 'sensational', 'tremendous',
  'monumental', 'catastrophic', 'disastrous', 'tragic', 'lethal', 'deadly',
  'lifeless', 'motionless', 'speechless', 'breathless', 'ageless', 'endless',
  'boundless', 'priceless', 'worthless', 'useless', 'hopeless',
]);

/**
 * Чи є слово в списку non-gradable (без ступенів порівняння). Винесено окремо,
 * щоб degree-forms.ts міг відсіяти такі слова ДО правил -ed/-ly.
 */
export function isNonGradable(word: string): boolean {
  return NO_DEGREE_WORDS.has(word.toLowerCase().trim());
}

/**
 * Двоскладові закінчення, що традиційно беруть -er/-est замість more/most.
 *
 * 🟢 ВИПРАВЛЕНО: прибрано /er$/ з цього списку. Раніше він мав ловити
 * "легкі" прикметники типу "clever -> cleverer", але хибно спрацьовував
 * і на словах, де "-er" — це частина кореня, а не суфікс ступеня
 * порівняння (наприклад "other" -> ставало б "otherer"/"otherest",
 * чого в англійській мові не існує). Тепер такі слова або явно занесені
 * в NO_DEGREE_WORDS (якщо взагалі не мають ступенів порівняння), або —
 * якщо колись трапиться щось на кшталт "clever", не покрите списком —
 * впадуть у безпечну гілку ambiguous ("more clever"/"most clever"),
 * що є граматично коректним варіантом і ніколи не породжує неіснуюче слово.
 */
const TWO_SYLLABLE_ER_EST_ENDINGS = [/y$/, /ow$/, /le$/, /some$/, /et$/, /on$/];

function countSyllablesApprox(word: string): number {
  const w = word.toLowerCase().replace(/e$/, ''); // німа "e" на кінці не рахуємо
  const matches = w.match(/[aeiouy]+/g);
  return matches ? matches.length : 1;
}

export interface AdjectiveFormsResult {
  comparative: string;
  superlative: string;
  isIrregular: boolean;
  hasNoDegree: boolean;
  /** true, якщо слово не підпало чітко під жодне правило — рекомендовано
   *  перевірку AI/людиною, а не сліпе застосування форми. */
  ambiguous: boolean;
}

export function getAdjectiveForms(base: string): AdjectiveFormsResult {
  const lower = base.trim().toLowerCase();

  if (NO_DEGREE_WORDS.has(lower)) {
    return { comparative: '', superlative: '', isIrregular: false, hasNoDegree: true, ambiguous: false };
  }

  const irregular = BY_BASE.get(lower);
  if (irregular) {
    return {
      comparative: irregular.comparative,
      superlative: irregular.superlative,
      isIrregular: true,
      hasNoDegree: false,
      ambiguous: false,
    };
  }

  const syllables = countSyllablesApprox(lower);

  // 1 склад -> завжди -er/-est (за стандартними орфографічними правилами)
  if (syllables === 1) {
    return buildSuffixForms(lower);
  }

  // 2 склади, закінчення -y -> -ier/-iest
  if (syllables === 2 && /[^aeiou]y$/.test(lower)) {
    const stem = lower.slice(0, -1);
    return {
      comparative: stem + 'ier',
      superlative: stem + 'iest',
      isIrregular: false,
      hasNoDegree: false,
      ambiguous: false,
    };
  }

  // 2 склади з типовими "легкими" закінченнями -> -er/-est
  if (syllables === 2 && TWO_SYLLABLE_ER_EST_ENDINGS.some(re => re.test(lower))) {
    return buildSuffixForms(lower);
  }

  // 2 склади без чіткого патерну (напр. clever, quiet) —
  // позначаємо ambiguous для ручної/AI перевірки.
  if (syllables === 2) {
    return {
      comparative: `more ${lower}`,
      superlative: `most ${lower}`,
      isIrregular: false,
      hasNoDegree: false,
      ambiguous: true,
    };
  }

  // 3+ склади -> завжди more/most
  return {
    comparative: `more ${lower}`,
    superlative: `most ${lower}`,
    isIrregular: false,
    hasNoDegree: false,
    ambiguous: false,
  };
}

function buildSuffixForms(stem: string): AdjectiveFormsResult {
  let s = stem;

  // Якщо закінчується на 'e', просто додаємо 'r' / 'st' (large -> larger)
  if (/e$/.test(s)) {
    return {
      comparative: s + 'r',
      superlative: s + 'st',
      isIrregular: false,
      hasNoDegree: false,
      ambiguous: false,
    };
  }

  // CVC (Приголосна-Голосна-Приголосна) -> подвоєння кінцевої приголосної (big -> bigger, hot -> hotter)
  // Обмеження s.length <= 4 допомагає уникнути подвоєння в складних словах,
  // але дозволяє обробити 'thin', 'fat', 'sad', 'wet', 'red', 'flat'.
  if (/^[^aeiou]*[aeiou][bcdfgklmnprtvz]$/.test(s) && s.length <= 4) {
    const last = s[s.length - 1];
    return {
      comparative: s + last + 'er',
      superlative: s + last + 'est',
      isIrregular: false,
      hasNoDegree: false,
      ambiguous: false,
    };
  }

  // Стандартне додавання -er / -est (fast -> faster, thick -> thicker)
  return {
    comparative: s + 'er',
    superlative: s + 'est',
    isIrregular: false,
    hasNoDegree: false,
    ambiguous: false,
  };
}