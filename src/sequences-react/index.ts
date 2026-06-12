/**
 * React timeline-editor surface for the sequences module: engine/media/
 * component seams (contracts), the command-stack editing engine, the media
 * pipeline (frame provider, waveform, transcription), the editor components,
 * and the code-split `React.lazy` entry.
 *
 * Never re-exported from the package root — react is an optional peer
 * (the `web-react` precedent). Engine and media modules are import-safe in
 * server bundles; DOM access begins only inside component render and
 * provider/clock method calls.
 */
export * from './contracts'
export * from './engine/command-stack'
export * from './engine/commands'
export * from './engine/zoom'
export * from './engine/snap'
export * from './engine/playback'
export * from './media/frame-provider'
export * from './media/waveform'
export * from './media/transcription'
export * from './components/index'
export * from './lazy'
