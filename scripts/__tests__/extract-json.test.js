const test = require('node:test');
const assert = require('node:assert');
const { extractJSON } = require('../generate-config.js');

test('extracts JSON from a single fenced ```json block', () => {
  const input = '```json\n{"a":1}\n```';
  assert.strictEqual(extractJSON(input), '{"a":1}');
});

test('extracts fenced block surrounded by prose', () => {
  const input = 'some prose\n```json\n{"a":1}\n```\nmore prose';
  assert.strictEqual(extractJSON(input), '{"a":1}');
});

test('returns the LAST fenced block when multiple are present', () => {
  const input = '```json\n{"a":1}\n```\ntext\n```json\n{"b":2}\n```';
  assert.strictEqual(extractJSON(input), '{"b":2}');
});

test('returns bare JSON when no fences are present', () => {
  assert.strictEqual(extractJSON('{"a":1}'), '{"a":1}');
});

test('throws on unbalanced braces', () => {
  assert.throws(() => extractJSON('{"a":1'), /Unbalanced braces/);
});

test('handles a brace inside a string literal', () => {
  const input = '{"s":"a{b"}';
  assert.strictEqual(extractJSON(input), '{"s":"a{b"}');
});

test('throws when no JSON is present', () => {
  assert.throws(() => extractJSON('just prose, no json here'), /No \{ found/);
});
