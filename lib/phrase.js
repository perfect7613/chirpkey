// Loose matching for a spoken secret phrase, since speech-to-text varies
// ("Blue tiger 7" vs "blue tiger seven." vs "bluetiger seven").
const NUM = { zero: "0", oh: "0", one: "1", two: "2", to: "2", too: "2", three: "3", four: "4", for: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };

export function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => NUM[w] ?? w)
    .join("");
}

export function phraseMatches(heard, secret) {
  const h = normalize(heard);
  const s = normalize(secret);
  if (!h || !s) return false;
  return h === s || h.includes(s);
}
