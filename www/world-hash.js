// World seeds are folded by Unicode code point, including unpaired surrogates
// from older saves. Most fish IDs occupy a single code unit per point.
export function hash(text, seed = 2166136261) {
  for (let i = 0; i < text.length; i++) {
    const point = text.codePointAt(i);
    seed = Math.imul(seed ^ point, 16777619);
    if (point > 0xffff) i++;
  }
  return seed >>> 0;
}
