/**
 * Cross-surface validator hardening:
 *
 *  1. Media-URL parity — the sequences (`assertSequenceMediaUrl`) and
 *     design-canvas (`assertSceneMediaSrc`) boundaries both delegate to the ONE
 *     shared `assertMediaUrl` rule, so they reject the SAME adversarial schemes
 *     and accept the SAME good references. Previously the canvas rule skipped
 *     trimming and named-rejection, letting the two surfaces drift.
 *  2. Color validator — `assertColor` rejected 5/7-digit hex and out-of-range
 *     rgb channels via a sloppy `{3,8}` / unbounded `\d{1,3}` pattern. The
 *     tightened rule accepts only {3,4,6,8}-digit hex and 0..255 channels while
 *     leaving every valid color in the repo corpus green.
 */

import { describe, expect, it } from 'vitest'
import { assertMediaUrl } from '../src/web'
import { assertSequenceMediaUrl } from '../src/sequences/validate'
import { assertColor, assertSceneMediaSrc } from '../src/design-canvas/model'

const MALICIOUS = [
  'file:///sandbox/out.mp4',
  'data:video/mp4;base64,AAAA',
  'data:image/png;base64,abc',
  'blob:https://evil.example/uuid',
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'vbscript:msgbox(1)',
  '/tmp/render.mp4',
  '/home/agent/render.mp4',
  '  file:///leading-space.mp4',
  '\tdata:text/plain,x',
  'clips/relative.mp4',
  'ftp://example.com/x.mp4',
  '',
]

const GOOD = [
  'https://cdn.example.com/v.mp4',
  'http://localhost:8787/v.mp4',
  'HTTPS://Cdn.Example.com/v.mp4',
  '/api/media/abc123',
  '  https://cdn.example.com/trimmed.mp4  ',
]

describe('media-url validator parity across surfaces', () => {
  it.each(MALICIOUS)('all three surfaces reject %j', (url) => {
    expect(() => assertMediaUrl(url)).toThrow()
    expect(() => assertSequenceMediaUrl(url)).toThrow()
    expect(() => assertSceneMediaSrc(url, 'src')).toThrow()
  })

  it.each(GOOD)('all three surfaces accept %j', (url) => {
    expect(() => assertMediaUrl(url)).not.toThrow()
    expect(() => assertSequenceMediaUrl(url)).not.toThrow()
    expect(() => assertSceneMediaSrc(url, 'src')).not.toThrow()
  })

  it('design-canvas now trims like sequences (parity on leading-whitespace bypass)', () => {
    // A leading-tab data: url used to slip past the canvas startsWith checks as
    // a generic reject vs sequences' named reject; both now trim then reject.
    expect(() => assertSceneMediaSrc('\tdata:x', 'src')).toThrow(/local sandbox file/)
    expect(() => assertSequenceMediaUrl('\tdata:x')).toThrow(/local sandbox file/)
  })

  it('preserves the sequences named-vs-generic messages', () => {
    expect(() => assertSequenceMediaUrl('file:///x.mp4')).toThrow('not a local sandbox file')
    expect(() => assertSequenceMediaUrl('clips/out.mp4')).toThrow('http(s)')
  })
})

describe('color validator tightening', () => {
  const VALID = [
    '#fff',
    '#ffff',
    '#ffffff',
    '#ffffffff',
    '#000000',
    '#aabbcc',
    'transparent',
    'rgb(0, 0, 0)',
    'rgb(17, 17, 17)',
    'rgb(255, 255, 255)',
    'rgba(0,0,0,0.5)',
    'rgba(52, 211, 153, 0.75)',
    'rgba(255,77,46,0.5)',
  ]

  it.each(VALID)('accepts the valid color %j (no corpus regression)', (color) => {
    expect(() => assertColor(color, 'fill')).not.toThrow()
  })

  it('rejects 5-digit hex', () => {
    expect(() => assertColor('#fffff', 'fill')).toThrow(/color/)
  })

  it('rejects 7-digit hex', () => {
    expect(() => assertColor('#fffffff', 'fill')).toThrow(/color/)
  })

  it('rejects 2-digit and 9-digit hex', () => {
    expect(() => assertColor('#ff', 'fill')).toThrow(/color/)
    expect(() => assertColor('#fffffffff', 'fill')).toThrow(/color/)
  })

  it('rejects an out-of-range rgb channel', () => {
    expect(() => assertColor('rgb(256, 0, 0)', 'fill')).toThrow(/color/)
    expect(() => assertColor('rgb(999, 0, 0)', 'fill')).toThrow(/color/)
    expect(() => assertColor('rgba(0, 300, 0, 0.5)', 'fill')).toThrow(/color/)
  })

  it('accepts the channel boundary exactly (255)', () => {
    expect(() => assertColor('rgb(255, 0, 0)', 'fill')).not.toThrow()
    expect(() => assertColor('rgba(255, 255, 255, 1)', 'fill')).not.toThrow()
  })

  it('still rejects non-colors', () => {
    expect(() => assertColor('not-a-color', 'fill')).toThrow(/color/)
    expect(() => assertColor('#gggggg', 'fill')).toThrow(/color/)
  })
})
