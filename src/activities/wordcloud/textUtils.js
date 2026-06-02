/**
 * Text helpers for the Word Cloud activity.
 *
 * Kept dependency-free and pure so the logic is easy to reason about and unit
 * test. The MVP deliberately uses simple frequency counting + light
 * normalization (the PRD defers embeddings / LLM clustering to a later phase).
 */

// Common filler words excluded from cloud sizing so the screen stays legible.
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'at', 'by', 'for', 'with',
  'about', 'to', 'from', 'in', 'on', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
  'she', 'we', 'they', 'them', 'my', 'your', 'our', 'their', 'me', 'us', 'as',
  'so', 'too', 'very', 'just', 'not', 'no', 'do', 'does', 'did', 'will', 'can'
]);

// Multi-word phrases collapsed to a single canonical term before tokenizing,
// so "A.I." / "AI" / "artificial intelligence" all merge into one cloud word.
const PHRASE_SYNONYMS = [
  [/\bartificial intelligence\b/g, 'ai'],
  [/\bmachine learning\b/g, 'ml'],
  [/\bwork life balance\b/g, 'work-life-balance']
];

// Minimal profanity list for the MVP auto-hide. Intentionally small and easy to
// extend; image/AI moderation is explicitly out of scope per the PRD.
const PROFANITY = new Set(['damn', 'crap', 'hell', 'shit', 'fuck', 'bitch', 'ass']);

// Tiny sentiment lexicon for the optional "sentiment" display mode. Word-level
// sentiment is necessarily coarse; the PRD treats this as an MVP signal, not
// analysis. Anything not listed is treated as neutral.
const POSITIVE_WORDS = new Set([
  'good', 'great', 'love', 'loved', 'awesome', 'amazing', 'excellent', 'happy',
  'excited', 'fun', 'wonderful', 'best', 'fantastic', 'positive', 'helpful',
  'easy', 'fast', 'beautiful', 'cool', 'nice', 'win', 'success', 'hope',
  'optimistic', 'productive', 'inspiring', 'grateful', 'confident', 'energized'
]);
const NEGATIVE_WORDS = new Set([
  'bad', 'hate', 'hated', 'terrible', 'awful', 'sad', 'angry', 'boring',
  'slow', 'hard', 'difficult', 'confusing', 'tired', 'stress', 'stressed',
  'worried', 'fear', 'scared', 'risk', 'risky', 'cost', 'expensive', 'bug',
  'broken', 'fail', 'failure', 'frustrated', 'anxious', 'overwhelmed', 'worst'
]);

function classifySentiment(term) {
  let pos = false, neg = false;
  for (const w of String(term).toLowerCase().split(/[\s-]+/)) {
    if (POSITIVE_WORDS.has(w)) pos = true;
    if (NEGATIVE_WORDS.has(w)) neg = true;
  }
  if (pos && !neg) return 'positive';
  if (neg && !pos) return 'negative';
  return 'neutral'; // none, or mixed
}

/**
 * Normalize a raw response into a comparable form: lower-cased, punctuation
 * stripped, whitespace collapsed, and known synonyms folded together.
 */
function normalizeText(text) {
  let n = String(text).toLowerCase().trim();
  for (const [pattern, replacement] of PHRASE_SYNONYMS) {
    n = n.replace(pattern, replacement);
  }
  // Drop punctuation that does not join words ("a.i." -> "ai", keep hyphens).
  n = n.replace(/[^\w\s-]/g, '').replace(/\.(?=\w)/g, '');
  return n.replace(/\s+/g, ' ').trim();
}

function tokenize(normalized) {
  return normalized
    .split(/[\s]+/)
    .map(t => t.replace(/^-+|-+$/g, ''))
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

function containsProfanity(normalized) {
  return tokenize(normalized).some(t => PROFANITY.has(t));
}

/**
 * Build a cloud from visible responses, ranked by weight (frequency + votes).
 *
 * Each distinct *response* is one cloud entry (e.g. "data privacy" stays whole),
 * so every answer a participant submits appears — duplicates merge and grow.
 * Normalization (lower-casing, synonym folding) is what merges near-duplicates.
 * `votes` is an optional Map of term -> upvote count.
 * Returns up to `limit` `{ word, count, votes, weight, sentiment }` entries.
 */
function buildCloud(responses, votes = new Map(), limit = 80) {
  const freq = new Map();
  for (const r of responses) {
    const term = (r.normalizedText || '').trim();
    if (!term) continue;
    freq.set(term, (freq.get(term) || 0) + 1);
  }
  return [...freq.entries()]
    .map(([word, count]) => {
      const v = votes.get(word) || 0;
      return { word, count, votes: v, weight: count + v, sentiment: classifySentiment(word) };
    })
    .sort((a, b) => b.weight - a.weight || a.word.localeCompare(b.word))
    .slice(0, limit);
}

module.exports = {
  normalizeText, tokenize, containsProfanity, buildCloud, classifySentiment, STOP_WORDS
};
