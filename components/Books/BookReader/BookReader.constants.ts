import { Dimensions } from 'react-native';

export const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Characters stripped when normalizing a raw text chunk into a comparable token.
// The hyphen is not here on purpose: "well-known" must stay one word (edge
// hyphens are trimmed in cleanWordForLookup). Typographic quotes, the
// ellipsis and brackets are stripped as well.
export const PUNCTUATION = /[.,\/#!$%\^&\*;:{}=_`~()?"«»“”„‟…\[\]‹›<>|+@]/g;

// Max number of words (the object: "turn [the light] off") allowed between a
// verb and its separable particle.
export const MAX_GAP = 2;

// Colors offered in the sentence-highlight color picker.
export const HIGHLIGHT_COLORS: string[] = ['#FFF1C9', '#D8F2D3', '#C9EBFF', '#E0D3EF'];
