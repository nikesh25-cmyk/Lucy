const cycle = 120 * 60_000;
/**
 * The phase model, in order. The voxel sky keys its light table by exactly these names
 * (src/scene/sky.js), and a test asserts the two lists cannot drift apart.
 */
export const ATMOSPHERE_PHASES = Object.freeze(['dawn', 'day', 'dusk', 'night']);
const labels = Object.freeze({
  dawn: Object.freeze({ label: 'First light', activity: 'A gentle start for learning and exploration.' }),
  day: Object.freeze({ label: 'Open skies', activity: 'A good time to gather, garden, and create.' }),
  dusk: Object.freeze({ label: 'Golden hour', activity: 'Share what you made and welcome your neighbors.' }),
  night: Object.freeze({ label: 'Starlight', activity: 'Rest, reflect, or visit the observatory.' }),
});

// A shared fictional sky; it changes presentation, never permissions or deadlines.
export function worldAtmosphere(timestamp = Date.now()) {
  const progress = ((timestamp % cycle) + cycle) % cycle, span = cycle / ATMOSPHERE_PHASES.length;
  const index = Math.floor(progress / span);
  return { phase: ATMOSPHERE_PHASES[index], ...labels[ATMOSPHERE_PHASES[index]], cycle_minutes: 120, server_time: timestamp,
    next_phase_at: timestamp + (span - progress % span) };
}
