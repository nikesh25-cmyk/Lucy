// Convert screen-relative walking to one authoritative grid step.
// The renderer's forward vector on the ground is (-sin(yaw), -cos(yaw)).
export function cameraWalkDirection(direction, yaw) {
  if (!['up', 'down', 'left', 'right'].includes(direction) || !Number.isFinite(yaw)) {
    throw new TypeError('Use a cardinal walking direction and a finite camera yaw.');
  }
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  const vectors = { up: [-sin, -cos], down: [sin, cos], right: [cos, -sin], left: [-cos, sin] };
  const [x, y] = vectors[direction];
  return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up');
}
