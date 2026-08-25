/**
 * A plucked string, simulated rather than drawn.
 *
 * This integrates the discrete wave equation. Nothing is a canned
 * animation loop: the picture is whatever the physics does with the impulses
 * it is given, and the impulses come from the model. A token arriving plucks
 * the string; the crests that travel outward and reflect off the ends ARE the
 * generation cadence, so a fast burst produces dense interference and a pause
 * produces a slow decay to flat. That coupling is the point — the surface is
 * showing the run, not decorating it.
 *
 *   u[t+1] = 2u[t] - u[t-1] + c^2 * laplacian(u)   then scaled by damping
 *
 * `c` stays well under the Courant limit for the grid so the integration
 * cannot blow up, and amplitudes are clamped on read rather than in the state,
 * which keeps the physics linear while the render stays bounded.
 * @module dsh-agent/field
 */

/** Wave speed. Below the stability limit for a unit grid step. */
const C2 = 0.22

/** Per-step amplitude retention. Below 1 so a quiet field returns to flat. */
const DAMPING = 0.985

/**
 * A plucked string: one dimension, fixed ends, impulses injected anywhere.
 *
 * Used for the live HUD row, where each arriving token is a pluck. Reflection
 * off the fixed ends is what makes a burst keep ringing after it stops, which
 * is the visual difference between "generating" and "just stopped".
 */
export class String1D {
  /**
   * @param {number} size - number of cells; the ends are held at zero.
   */
  constructor(size) {
    this.size = Math.max(4, size)
    this.now = new Float32Array(this.size)
    this.prev = new Float32Array(this.size)
    this.next = new Float32Array(this.size)
  }

  /**
   * Resize in place, preserving nothing: a resized terminal starts a new field
   * rather than stretching the old one into a shape the physics never had.
   * @param {number} size - the new cell count.
   */
  resize(size) {
    const wanted = Math.max(4, size)
    if (wanted === this.size) return
    this.size = wanted
    this.now = new Float32Array(wanted)
    this.prev = new Float32Array(wanted)
    this.next = new Float32Array(wanted)
  }

  /**
   * Add an impulse. Applied to the velocity term (the difference between the
   * current and previous state) rather than to position, so a pluck launches
   * travelling waves instead of teleporting a spike that then rings forever.
   * @param {number} at - cell index; clamped into the interior.
   * @param {number} strength - impulse magnitude, positive for a crest.
   */
  pluck(at, strength = 1) {
    const i = Math.min(this.size - 2, Math.max(1, Math.round(at)))
    this.prev[i] -= strength
  }

  /** Advance one step. */
  step() {
    const { now, prev, next, size } = this
    for (let i = 1; i < size - 1; i += 1) {
      const laplace = now[i - 1] + now[i + 1] - 2 * now[i]
      next[i] = (2 * now[i] - prev[i] + C2 * laplace) * DAMPING
    }
    // Fixed ends: the boundary cells stay zero, which is what reflects waves
    // back into the field instead of letting them leave it.
    next[0] = 0
    next[size - 1] = 0
    this.prev = now
    this.now = next
    this.next = prev
  }

}
