/**
 * english-verb-lexicon.ts
 *
 * Базові форми поширених англійських дієслів. Використовується лише як
 * ПІДКАЗКА: "у цього слова буває дієслівне значення". Потрібна, коли у
 * словнику (БД) слово є тільки як іменник ("train" — поїзд, "watch" —
 * годинник, "book" — книга), а в реченні воно вжите як дієслово
 * ("he trained", "she watches TV", "I booked a room").
 *
 * Список не мусить бути вичерпним: відсутнє дієслово означає лише, що
 * для нього не буде запропоновано нове дієслівне значення без
 * підтвердження контекстом (AI). Зайве слово коштує максимум одного
 * дешевого AI-запиту на унікальне речення — точності це не шкодить.
 */
import { COMMON_VERB_LEMMAS } from './english-lexicons';
import { IRREGULAR_VERBS } from './verb-morphology';

const VERBS = `
abandon absorb accept access accompany accomplish account accuse ache achieve acknowledge acquire act adapt add
address adjust admire admit adopt advance advise afford age agree aim alarm alert allow alter amaze amuse analyse
analyze anger announce annoy answer apologise apologize appeal appear applaud apply appoint appreciate approach
approve argue arise arm arrange arrest arrive ask assemble assess assign assist assume assure attach attack attempt
attend attract avoid awake award

back bake balance ban bandage bang bank bargain bark base bat bathe battle beam bear beat beg begin behave believe
belong bend bet bid bind bite blame blast bleed bless blind blink block bloom blossom blow blush board boast boil bolt
bomb book boost bore borrow bother bounce bow box brake branch brand breathe breed brew bribe bridge brief brighten
broadcast brush bubble buckle budget bug build bump burn burst bury butter button buzz

calculate call calm camp cancel care carry carve cash cast catch cause cease celebrate chain challenge change charge
chase chat cheat check cheer chew chill chip choke choose chop circle claim clap clean clear climb cling clip close
coach collapse collect colour color comb combine come comfort command comment commit communicate compare compete
complain complete compose concentrate concern conclude condemn conduct confess confirm confront confuse connect
conquer consider consist construct consult contain continue contribute control convert convince cook cool cooperate
cope copy correct cost cough count cover crack crash crawl create creep criticise criticize cross crowd crush cry
cuddle cure curl curse curve cut cycle

damage dance dare dash date deal debate decay deceive decide declare decline decorate decrease dedicate defeat
defend define delay delete delight deliver demand deny depart depend describe deserve design desire destroy detect
determine develop dial die dig dine dip direct disagree disappear disappoint discover discuss disguise dislike dismiss
display dissolve distribute disturb dive divide do dodge donate double doubt drag drain draw dream dress drift drill
drink drip drive drop drown drum dry dump dust dwell

earn ease eat echo edit educate elect embarrass embrace emerge employ empty enable encourage end endure engage enjoy
enter entertain escape establish estimate evaluate examine exceed exchange excite excuse execute exercise exhaust
exist expand expect experience experiment explain explode explore export expose express extend

face fade fail faint fall fancy fasten favour favor fear feed feel fence fetch fight file fill film find finish fire
fish fit fix flap flash flee float flood flow flower fly fold follow fool force forecast forget forgive form frame
free freeze frighten frown fry fuel function fund

gain gamble garden gather gaze generate get giggle give glance glare glide glow glue go grab grade grant grasp greet
grin grind grip groan grow growl guarantee guard guess guide

hammer hand handle hang happen harm hate haunt have head heal hear heat help hesitate hide highlight hike hire hit
hold hook hop hope host house hug hum hunt hurry hurt

identify ignore illustrate imagine imitate impress improve include increase indicate inform inherit injure insist
inspect inspire install intend interest interrupt introduce invent invest investigate invite involve iron issue

jail jam jog join joke judge juggle jump justify

keep kick kill kiss kneel knit knock know

label land last laugh launch lay lead leak lean leap learn leave lend let lick lie lift light like limit line link
list listen live load loan lock long look loosen lose love lower

mail make manage mark market marry master match matter mean measure meet melt mention mind miss mix moan mock
monitor mount move mourn multiply murder murmur mutter

nail name need nod note notice number nurse

obey object observe obtain occupy occur offend offer open operate oppose order organise organize overcome owe own

pack paddle paint park part pass paste pat pause pay pedal peel peep perform permit persuade phone pick picture pile
pinch place plan plant play plead please plug point poke polish pop pose possess post pour practise practice praise
pray preach prefer prepare present preserve press pretend prevent print proceed produce progress promise pronounce
protect protest prove provide publish pull pump punch punish purchase push put

qualify question queue quit quote

race rain raise rate reach react read realise realize receive recognise recognize recommend record recover reduce
refer reflect refuse regret reject relate relax release rely remain remark remember remind remove rent repair repeat
replace reply report represent request require rescue research reserve resign resist resolve respect respond rest
result retire return reveal review reward ride ring rinse rise risk roar rob rock roll rot row rub ruin rule run rush

sail save saw say scare scatter schedule scold score scrape scratch scream screw search seat secure see seem seize
select sell send sense separate serve set settle sew shade shake shape share shave shelter shine shiver shock shoot
shop shout show shower shrink shrug shut sigh sign signal sin sing sink sip sit sketch ski skip slap sleep slide slip
slow smash smell smile smoke snap sneak sneeze sniff snore snow soak sob solve sort sound spare spark speak spell
spend spill spin spit split spoil spot spray spread spring squash squeeze stab stain stamp stand stare start state
stay steal steer step stick sting stir stitch stop store storm stress stretch strike string strip stroke struggle
study stuff stumble submit succeed suck suffer suggest suit supply support suppose surprise surround survive suspect
swallow swap swear sweat sweep swim swing switch

tackle talk tap taste teach tear tease telephone tell tempt tend test thank think threaten throw tick tickle tie
tip tire toss touch tour tow trace track trade train transfer transform translate transport trap travel tread treat
tremble trick trip trot trouble trust try tug turn twist type

undergo understand undress unite unlock unpack upset urge use

value vanish visit voice volunteer vote

wait wake walk wander want warm warn wash waste watch water wave wear weave weep weigh welcome whip whisper whistle
win wind wink wipe wish witness wonder work worry wrap wreck wrestle write

x-ray yawn yell yield zip zoom
`;

const VERB_LEXICON = new Set<string>([
  ...VERBS.split(/\s+/).filter(w => /^[a-z]+$/.test(w)),
  ...COMMON_VERB_LEMMAS,
  ...IRREGULAR_VERBS.map(v => v.base),
]);

/** Чи є слово відомою базовою формою дієслова. */
export function isKnownVerbLemma(word: string): boolean {
  return VERB_LEXICON.has(word.toLowerCase().trim());
}
