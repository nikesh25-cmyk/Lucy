# NemoWorld introduction film

The project owner supplied `NEMO WORLD.mp4`. The hero uses a locally hosted 720p MP4 with its audio retained, prepared with macOS AVFoundation and network optimization. Duration: 92.76 seconds. The original supplied file is unchanged. A frame from that same film is the poster; no substitute film or generated imagery is used.

Playback starts only when the viewer chooses it. `preload="none"` avoids downloading the film at page load. Native controls provide sound, seeking and fullscreen; the header’s “Watch introduction” also works while signed in. Closing that dialog pauses playback, including Escape. The visible text describes the vision separately from current product capabilities.

The server streams a fixed allowlisted asset path and supports single HTTP byte ranges rather than reading the whole film into memory. Malformed and out-of-bounds ranges return 416. Video is public; accounts, runtime credentials and private world data remain behind their existing checks.

Verification: `hero-introduction-film` plays and decodes the complete 1280×720 film in real Chrome, checks no autoplay/preload, confirms pause on close, and checks a 390px-wide screen. `tests/media.test.js` exercises exact range bytes, suffix/open ranges, clamping, HEAD and invalid-range refusals.
