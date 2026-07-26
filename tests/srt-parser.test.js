const { parseSRT, toSeconds, findCue } = require('../src/srt-parser.js');

const SAMPLE = `1
00:00:01,000 --> 00:00:03,500
Hello there

2
00:00:04,000 --> 00:00:06,000
General Kenobi
`;

test('parses basic SRT into cues', () => {
  const cues = parseSRT(SAMPLE);
  expect(cues).toHaveLength(2);
  expect(cues[0].text).toBe('Hello there');
  expect(cues[0].start).toBeCloseTo(1.0);
  expect(cues[0].end).toBeCloseTo(3.5);
});

test('strips a leading BOM', () => {
  const cues = parseSRT('\uFEFF' + SAMPLE);
  expect(cues).toHaveLength(2);
});

test('accepts both comma and dot as ms separator', () => {
  expect(toSeconds('00:00:01,500')).toBeCloseTo(1.5);
  expect(toSeconds('00:00:01.500')).toBeCloseTo(1.5);
});

test('skips empty blocks', () => {
  const withEmpty = SAMPLE + '\n3\n00:00:07,000 --> 00:00:08,000\n\n';
  const cues = parseSRT(withEmpty);
  expect(cues).toHaveLength(2);
});

test('findCue returns the matching line for a timestamp', () => {
  const cues = parseSRT(SAMPLE);
  expect(findCue(cues, 2.0)).toBe('Hello there');
  expect(findCue(cues, 5.0)).toBe('General Kenobi');
  expect(findCue(cues, 3.6)).toBe('');
});
