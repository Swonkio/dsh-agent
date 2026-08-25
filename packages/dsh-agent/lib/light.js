/**
 * The surface's light model: caustics, shared by every element that is lit.
 *
 * One function so the cold-start field, the live ribbon and anything else that
 * wants moving light are literally the same illumination sampled in different
 * places, rather than three effects that merely resemble each other. Continuity
 * of light is what makes a set of panels read as one surface.
 * @module dsh-agent/light
 */

/** Spatial frequency of the surface. Higher gives finer filaments. */
export const SCALE = 15

/** How tightly the crests concentrate. Higher gives thinner, brighter lines. */
export const SHARPNESS = 9

/** How far the sampling grid is bent before the waves are summed. */
export const WARP = 0.9

/**
 * Caustic intensity at one point.
 *
 * Four wave terms are summed and the result is measured by how close it sits
 * to zero, not by its height: light concentrates where the contributing waves
 * CANCEL, and raising that to a power thins the cancellation lines into
 * filaments. Reading the crests instead would give smooth blobs, which is what
 * a water surface looks like from above rather than what its light does below.
 *
 * The sampling grid is bent by a slow wave first, so the filaments curve and
 * drift instead of lying on a regular lattice.
 * @param {number} x - normalised horizontal position.
 * @param {number} y - normalised vertical position.
 * @param {number} time - animation phase.
 * @param {number} [scale] - spatial frequency; lower widens the filaments.
 * @param {number} [sharpness] - how tightly crests concentrate; 1 leaves the
 *   falloff smooth, which is what an outline wants — the sharpened form spends
 *   most of its range near zero and renders a one-cell-tall edge as flat dark.
 * @returns {number} intensity in [0, 1].
 */
export function caustic(x, y, time, scale = SCALE, sharpness = SHARPNESS) {
  const wx = x * scale + WARP * Math.sin(y * scale * 0.6 + time * 0.8)
  const wy = y * scale + WARP * Math.cos(x * scale * 0.5 - time * 0.7)
  const sum = Math.sin(wx + time)
    + Math.sin(wy * 1.1 - time * 0.9)
    + Math.sin((wx + wy) * 0.7 + time * 1.3)
    + Math.sin(Math.sqrt(wx * wx + wy * wy) * 0.9 - time * 1.6)
  return (1 - Math.abs(sum / 4)) ** sharpness
}

/**
 * Gamma lift applied before a palette lookup.
 *
 * Caustic intensity is dominated by near-zero values, because most of a lit
 * surface is the shadow between filaments. Mapping it linearly spends almost
 * the whole palette on the dark end and the filaments never separate from
 * their ground.
 * @param {number} intensity - raw caustic intensity.
 * @returns {number} the lifted value.
 */
export function lift(intensity) {
  return intensity ** 0.55
}
