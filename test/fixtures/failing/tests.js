// Deliberately failing test file: proves the generated sh script reports FAIL
// and still exits 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('this challenge test always fails', () => {
  assert.equal(1, 2);
});

test('this one passes anyway', () => {
  assert.equal(2, 2);
});
