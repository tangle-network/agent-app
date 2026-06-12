/**
 * Code-split entry for the timeline editor. The editor pulls in canvas
 * painting, waveform decode, and gesture machinery products only need on the
 * sequence route — `React.lazy` keeps it out of their main bundle. Mount
 * inside a `<Suspense>` boundary.
 */

import React from 'react'

export const SequenceTimelineEditorLazy = React.lazy(() => import('./components/TimelineEditor'))
