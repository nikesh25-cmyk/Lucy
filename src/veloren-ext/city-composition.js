// Pure additive preparation; activation and native terrain surveying belong to the installer.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, PLACES, MANIFEST_LIMITS } from './world-manifest.js';
import { MANIFEST_PATH, PROJECTS_PATH } from './world-life.js';

const content = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'content');
export const CITY_COMPOSITION_PATHS = Object.freeze({
  manifest: MANIFEST_PATH,
  cityManifest: join(content, 'veloren-ai-city.json'),
  projects: PROJECTS_PATH,
  cityProjects: join(content, 'veloren-ai-city-projects.json'),
  landmarks: join(content, 'veloren-world-landmarks.json'),
  extraLandmarks: join(content, 'veloren-landmarks-extra.json'),
  cityLandmarks: join(content, 'veloren-ai-city-landmarks.json'),
});

function uniqueRows(documents, field) {
  const ids = new Set();
  return documents.flatMap(document => {
    if (!document || !Array.isArray(document[field])) throw new Error(`Missing ${field} array`);
    return document[field].map(row => {
      if (!row || typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.id)) throw new Error(`Invalid ${field} ID`);
      if (ids.has(row.id)) throw new Error(`Duplicate ${field} ID: ${row.id}`);
      ids.add(row.id);
      return structuredClone(row);
    });
  });
}

/** Merge checked snapshots without mutating or retaining mutable references to any source. */
export function composeNativeCity({manifest, cityManifest, projects, cityProjects, landmarks, extraLandmarks, cityLandmarks}) {
  for (const source of [manifest, cityManifest]) {
    const errors = validateManifest(source);
    if (errors.length) throw new Error(`Invalid source manifest: ${errors.join('; ')}`);
  }
  if (manifest.site !== cityManifest.site) throw new Error('City manifest site must match the base site');
  for (const source of [projects, cityProjects]) {
    if (source?.format !== 'nemo-works-v1') throw new Error('Unsupported projects format');
  }
  if (landmarks?.format !== 'veloren-world-landmarks-v1') throw new Error('Unsupported base landmarks format');
  for (const source of [extraLandmarks, cityLandmarks]) {
    if (source?.format !== 'nemo-landmarks-extra-v1') throw new Error('Unsupported extra landmarks format');
  }
  const combinedManifest = {
    ...structuredClone(manifest),
    area: {...structuredClone(manifest.area), radius: Math.max(manifest.area.radius, cityManifest.area.radius)},
    groups: uniqueRows([manifest, cityManifest], 'groups'),
  };
  const errors = validateManifest(combinedManifest);
  if (errors.length) throw new Error(`Invalid combined manifest: ${errors.join('; ')}`);
  const combinedProjects = {...structuredClone(projects), projects: uniqueRows([projects, cityProjects], 'projects')};
  const combinedLandmarks = {format: 'nemo-landmarks-extra-v1', landmarks: uniqueRows([landmarks, extraLandmarks, cityLandmarks], 'landmarks')};
  const projectIds = new Set(combinedProjects.projects.map(row => row.id));
  const landmarkIds = new Set(combinedLandmarks.landmarks.map(row => row.id));
  for (const group of combinedManifest.groups) {
    if (group.project && !projectIds.has(group.project)) throw new Error(`Missing project ${group.project} for ${group.id}`);
    if (group.crew > 0 && (!group.site || !landmarkIds.has(group.site))) throw new Error(`Unresolved crew site ${group.site || '(missing)'} for ${group.id}`);
  }
  const extent = MANIFEST_LIMITS.max_anchor_offset;
  for (const landmark of combinedLandmarks.landmarks) {
    if (landmark.site !== combinedManifest.site || !PLACES.sites.get(landmark.site)?.includes(landmark.plot)) throw new Error(`Invalid landmark site/plot: ${landmark.id}`);
    if (!Number.isInteger(landmark.nth) || landmark.nth < 0 || landmark.nth > 7) throw new Error(`Invalid landmark nth: ${landmark.id}`);
    for (const axis of ['dx','dy']) {
      const value = landmark[axis] ?? 0;
      if (!Number.isInteger(value) || Math.abs(value) > extent) throw new Error(`Invalid landmark ${axis}: ${landmark.id}`);
    }
    if (!Number.isFinite(landmark.radius) || landmark.radius <= 0 || landmark.radius > 24) throw new Error(`Invalid landmark radius: ${landmark.id}`);
  }
  return {manifest: combinedManifest, projects: combinedProjects, landmarks: combinedLandmarks};
}

/** Read repository-owned JSON; callers may explicitly provide alternate input paths for packaging. */
export function loadNativeCityComposition(paths = CITY_COMPOSITION_PATHS) {
  const sources = Object.fromEntries(Object.entries({...CITY_COMPOSITION_PATHS, ...paths})
    .map(([key,path]) => [key, JSON.parse(readFileSync(path, 'utf8'))]));
  return composeNativeCity(sources);
}
