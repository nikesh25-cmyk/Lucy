import { openSync, fstatSync, readSync, closeSync } from 'node:fs';

/** Same bounds as nemo-link-proto/src/home.rs, not a new land definition. */
export function nativeHomePlot(id) {
  const match = /^plot:0:0:([0-7]):([0-7])$/.exec(typeof id === 'string' ? id : '');
  return Boolean(match && !['3', '4'].includes(match[1]) && !['3', '4'].includes(match[2]));
}

// A trusted server-side file, never a client path. The native server writes exactly the 36
// supported plot estimates at startup. Bound bytes/shape and fail closed when a configured report
// is missing or invalid. The engine still decides actual terrain acceptance during construction.
export function groundReport(path) {
  if (!path) return { state: 'unchecked', suitable: null };
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size < 1 || size > 65536) throw new Error('Invalid ground report size');
    const bytes = Buffer.alloc(size);
    if (readSync(fd, bytes, 0, size, 0) !== size) throw new Error('Incomplete ground report');
    const report = JSON.parse(bytes.toString('utf8'));
    if (report.spacing !== 14 || !Array.isArray(report.plots) || report.plots.length !== 36) throw new Error('Invalid ground report shape');
    const suitable = new Map();
    for (const plot of report.plots) {
      if (!nativeHomePlot(plot.plot) || typeof plot.suitable !== 'boolean' || suitable.has(plot.plot)) throw new Error('Invalid ground report plot');
      suitable.set(plot.plot, plot.suitable);
    }
    return { state: 'estimated', suitable };
  } catch { return { state: 'unavailable', suitable: null }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function defaultPlotsPath() {
  if (process.env.NEMO_HOME_PLOTS) return process.env.NEMO_HOME_PLOTS;
  const world = process.env.NEMO_WORLD_RECORD;
  return world?.endsWith('.world.json') ? world.replace(/\.world\.json$/, '.home_plots.json') : null;
}
