import { CITY_SCHEMA, NativeCityService } from './city-life.js';

const runtimes = new WeakMap();
const logFailure = (action, error) => {
  const message = String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 180);
  console.error(`[native-city] ${action} failed: ${message}`);
};

export const cityLifeExtension = {
  name: 'city_life',
  schema: CITY_SCHEMA,
  director(link, resident_id) {
    return link.nativeCity?.enabled === true && resident_id === 'lw-theron'
      ? { mode: 'work', target_landmark_id: 'city-arrival' } : null;
  },
  async handle() { return false; },
};

// The caller owns shutdown. A replacement retires the preceding timer before assigning a
// new service; old stop closures cannot disable or clear the replacement runtime.
export function startNativeCity(link, platform, { enabled = false, recordPath, intervalMs = 2000 } = {}) {
  runtimes.get(link)?.();
  const city = new NativeCityService(link, platform, { enabled, recordPath });
  link.nativeCity = city;
  const interval = Number.isFinite(intervalMs) ? Math.min(60_000, Math.max(1000, Math.trunc(intervalMs))) : 2000;
  let timer = null, stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    city.enabled = false;
    try { if (timer !== null) clearInterval(timer); }
    catch (error) { logFailure('stop', error); }
    timer = null;
    if (runtimes.get(link) === stop) runtimes.delete(link);
  };
  if (city.enabled) {
    timer = setInterval(() => {
      if (stopped || !city.enabled) return;
      try { city.tick(); }
      catch (error) { logFailure('tick', error); }
    }, interval);
    timer.unref?.();
  }
  runtimes.set(link, stop);
  return stop;
}
