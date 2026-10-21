/**
 * Prompt construction and the machine-readable test-file envelope.
 *
 * The envelope markers are deliberately unusual so that a verbatim round-trip
 * of the challenge test file is possible (used by the mock provider and by the
 * regression test that proves a request body arrives byte-identical).
 */

export const BEGIN_MARKER = '===8<=== BEGIN TEST FILE ===8<===';
export const END_MARKER = '===8<=== END TEST FILE ===8<===';

/** File vocabulary the challenge platform accepts. */
export const ACCEPTED_VOCABULARY = Object.freeze([
  'App.jsx',
  'App.css',
  'index.html',
  'styles/style.css',
  'script.js',
  '{Component}.jsx',
]);

const SYSTEM_PROMPT = [
  'You are NeoSolver, a code generator for a daily coding challenge.',
  '',
  'The user message contains the challenge test file verbatim, between the markers',
  `"${BEGIN_MARKER}" and "${END_MARKER}". That test file is authoritative.`,
  'Read it, and produce exactly the source files it requires.',
  '',
  'Return each file as one fenced code block. The info string (the text right',
  'after the opening ``` fence) is that file\'s relative POSIX path, and the block',
  'body is the COMPLETE file content. For example:',
  '',
  '```jsx App.jsx',
  '<complete file content>',
  '```',
  '',
  '```css App.css',
  '<complete file content>',
  '```',
  '',
  'Rules:',
  '- No JSON: do not wrap the files in a {"files": {...}} object.',
  '- No prose before, between, or after the blocks — only the fenced blocks.',
  '- Each block holds the COMPLETE file content: never a diff, never a fragment.',
  '- Paths are relative and POSIX-style: no "..", no leading "/", no leading "-".',
  '- Produce the minimum set of files that makes the tests pass.',
  `- Accepted file vocabulary: ${ACCEPTED_VOCABULARY.join(', ')}.`,
  '- Never echo the test file back as a generated file.',
  '- If the test file is ambiguous, pick the simplest interpretation.',
].join('\n');

/**
 * @param {{testFile: string, targets?: string[]}} request
 * @returns {Array<{role: string, content: string}>}
 */
export function buildMessages({ testFile, targets = [] }) {
  const user = ['Solve this challenge. The test file below is authoritative.', ''];
  if (targets.length > 0) {
    user.push('The expected output files are:');
    for (const target of targets) user.push(`- ${target}`);
    user.push('');
  }
  user.push(BEGIN_MARKER);
  user.push(testFile);
  user.push(END_MARKER);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user.join('\n') },
  ];
}

export const SYSTEM_PROMPT_TEXT = SYSTEM_PROMPT;

/**
 * Exact inverse of {@link buildMessages}: recover the test file verbatim.
 *
 * Anchors on the marker pair in the USER message: the last BEGIN marker and the
 * first END marker after it. (The system prompt also mentions both markers in
 * prose, so anchoring from the left of a concatenated transcript would match the
 * wrong region.)
 *
 * @param {string} text
 * @returns {string|null}
 */
export function extractTestFile(text) {
  const haystack = String(text);
  const begin = haystack.lastIndexOf(BEGIN_MARKER);
  if (begin === -1) return null;
  const bodyStart = haystack.indexOf('\n', begin);
  if (bodyStart === -1) return null;
  const end = haystack.indexOf(END_MARKER, bodyStart + 1);
  if (end === -1) return null;
  let body = haystack.slice(bodyStart + 1, end);
  if (body.endsWith('\n')) body = body.slice(0, -1);
  return body;
}
