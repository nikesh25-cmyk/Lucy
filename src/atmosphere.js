const cycle = 120 * 60_000;
const phases = [
  { phase: 'dawn', label: 'First light', activity: 'A gentle start for learning and exploration.' },
  { phase: 'day', label: 'Open skies', activity: 'A good time to gather, garden, and create.' },
  { phase: 'dusk', label: 'Golden hour', activity: 'Share what you made and welcome your neighbors.' },
  { phase: 'night', label: 'Starlight', activity: 'Rest, reflect, or visit the observatory.' },
];

// A shared fictional sky; it changes presentation, never permissions or deadlines.
export function worldAtmosphere(timestamp = Date.now()) {
  const progress = ((timestamp % cycle) + cycle) % cycle;
  const index = Math.floor(progress / (cycle / phases.length));
  return { ...phases[index], cycle_minutes: 120, server_time: timestamp,
    next_phase_at: timestamp + (cycle / phases.length - progress % (cycle / phases.length)) };
}
