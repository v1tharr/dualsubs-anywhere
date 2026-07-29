const { parseSRT, toSeconds, findCue, decodeSubtitleBytes } = require('../src/srt-parser.js');

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

test('strips basic formatting tags like <i></i>', () => {
  const withTags = `1
00:00:01,000 --> 00:00:03,000
<i>That's why I think it's best</i>
to take it one step at a time.
`;
  const cues = parseSRT(withTags);
  expect(cues[0].text).toBe("That's why I think it's best\nto take it one step at a time.");
});

test('decodeSubtitleBytes falls back to windows-1251 for non-UTF-8 Russian subtitle bytes', () => {
  // "Послушай!" encoded as Windows-1251 (typical of old .srt files from RU trackers)
  const cp1251Bytes = new Uint8Array([0xCF, 0xEE, 0xF1, 0xEB, 0xF3, 0xF8, 0xE0, 0xE9, 0x21]);
  expect(decodeSubtitleBytes(cp1251Bytes)).toBe('Послушай!');
});

test('decodeSubtitleBytes keeps valid UTF-8 as UTF-8', () => {
  const utf8Bytes = new TextEncoder().encode('Привет, мир!');
  expect(decodeSubtitleBytes(utf8Bytes)).toBe('Привет, мир!');
});
