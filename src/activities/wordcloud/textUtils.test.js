/**
 * Lightweight tests for the word cloud text utilities.
 * Run with:  node src/activities/wordcloud/textUtils.test.js
 *
 * Uses only Node's built-in `assert` so there is no test-runner dependency to
 * install — keeping with the project's zero-extra-deps approach.
 */
const assert = require('assert');
const {
  normalizeText, tokenize, containsProfanity, buildCloud, classifySentiment
} = require('./textUtils');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('textUtils');

test('normalizeText lowercases and trims', () => {
  assert.strictEqual(normalizeText('  Hello  '), 'hello');
});

test('normalizeText merges A.I. / AI / artificial intelligence', () => {
  assert.strictEqual(normalizeText('A.I.'), 'ai');
  assert.strictEqual(normalizeText('AI'), 'ai');
  assert.strictEqual(normalizeText('Artificial Intelligence'), 'ai');
});

test('normalizeText collapses internal whitespace', () => {
  assert.strictEqual(normalizeText('data    privacy'), 'data privacy');
});

test('tokenize drops stop words and short tokens', () => {
  assert.deepStrictEqual(tokenize(normalizeText('the cost of data')), ['cost', 'data']);
});

test('containsProfanity flags blocked words', () => {
  assert.strictEqual(containsProfanity(normalizeText('this is crap')), true);
  assert.strictEqual(containsProfanity(normalizeText('this is fine')), false);
});

test('buildCloud counts frequency and sorts descending', () => {
  const responses = [
    { normalizedText: normalizeText('cost') },
    { normalizedText: normalizeText('cost') },
    { normalizedText: normalizeText('trust') },
    { normalizedText: normalizeText('AI') },
    { normalizedText: normalizeText('artificial intelligence') }
  ];
  const cloud = buildCloud(responses);
  const map = Object.fromEntries(cloud.map(c => [c.word, c.count]));
  assert.strictEqual(map.cost, 2);
  assert.strictEqual(map.ai, 2);   // "AI" + "artificial intelligence" merged
  assert.strictEqual(map.trust, 1);
  assert.strictEqual(cloud[0].count, 2); // most frequent first
});

test('buildCloud folds votes into weight and ranking', () => {
  const responses = [
    { normalizedText: normalizeText('cost') },
    { normalizedText: normalizeText('cost') },
    { normalizedText: normalizeText('trust') }
  ];
  const votes = new Map([['trust', 5]]); // trust: count 1 + 5 votes = weight 6
  const cloud = buildCloud(responses, votes);
  assert.strictEqual(cloud[0].word, 'trust');     // out-ranks cost on weight
  assert.strictEqual(cloud[0].weight, 6);
  assert.strictEqual(cloud[0].votes, 5);
  const cost = cloud.find(c => c.word === 'cost');
  assert.strictEqual(cost.weight, 2); // count 2, no votes
});

test('classifySentiment labels positive / negative / neutral', () => {
  assert.strictEqual(classifySentiment('love'), 'positive');
  assert.strictEqual(classifySentiment('stress'), 'negative');
  assert.strictEqual(classifySentiment('banana'), 'neutral');
});

test('buildCloud entries carry a sentiment label', () => {
  const cloud = buildCloud([{ normalizedText: 'love' }]);
  assert.strictEqual(cloud[0].sentiment, 'positive');
});

console.log(`\n${passed} passed`);
