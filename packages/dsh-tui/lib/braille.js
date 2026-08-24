/**
 * A pixel canvas over Braille cells.
 *
 * Every Braille glyph carries a 2x4 dot matrix, so a canvas of them addresses
 * eight times as many pixels as a character grid of the same size — enough to
 * draw a continuous trace where block glyphs can only step between a handful
 * of heights. That is the difference between a bar chart and an instrument,
 * and it is the whole reason this exists.
 *
 * The dot bit order is not sequential: dots 1-6 were the original six-dot
 * cell, and dots 7-8 were appended underneath when Braille was extended to
 * eight, so the bottom row of each column sits at the top of the byte.
 * @module dsh-tui/braille
 */

/** Base code point of the 8-dot Braille block. */
const BRAILLE_BASE = 0x2800

/**
 * Dot bit by (column, row). Column 0 is the left pixel column, row 0 the top.
 * The fourth row's bits (0x40, 0x80) break the otherwise regular progression
 * because dots 7 and 8 were added to the encoding after dots 1-6.
 */
const DOTS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
]

/** Pixels per cell. */
export const CELL_WIDTH = 2
export const CELL_HEIGHT = 4

/**
 * A fixed-size pixel canvas rendered as one row of Braille cells per four
 * pixel rows.
 */
export class Braille {
  /**
   * @param {number} cells - width in character cells.
   * @param {number} rows - height in character rows.
   */
  constructor(cells, rows = 1) {
    this.cells = cells
    this.rows = rows
    this.width = cells * CELL_WIDTH
    this.height = rows * CELL_HEIGHT
    this.bits = new Uint8Array(cells * rows)
  }

  /** Clear every pixel. */
  clear() {
    this.bits.fill(0)
  }

  /**
   * Light one pixel. Coordinates outside the canvas are dropped rather than
   * clamped: a trace that leaves the viewport should be cut off at the edge,
   * not smeared along it.
   * @param {number} x - pixel column.
   * @param {number} y - pixel row.
   */
  plot(x, y) {
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return
    const cell = Math.floor(px / CELL_WIDTH) + Math.floor(py / CELL_HEIGHT) * this.cells
    this.bits[cell] |= DOTS[px % CELL_WIDTH][py % CELL_HEIGHT]
  }

  /**
   * Draw a straight run between two pixels, so a trace stays connected when
   * consecutive samples differ by more than one row.
   * @param {number} x0 - start column.
   * @param {number} y0 - start row.
   * @param {number} x1 - end column.
   * @param {number} y1 - end row.
   */
  line(x0, y0, x1, y1) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    if (steps === 0) {
      this.plot(x0, y0)
      return
    }
    for (let i = 0; i <= steps; i += 1) {
      this.plot(x0 + (x1 - x0) * (i / steps), y0 + (y1 - y0) * (i / steps))
    }
  }

  /**
   * Render one character row.
   * @param {number} row - which row of cells to render.
   * @param {(cell: number) => ((text: string) => string) | undefined} [colour]
   *   optional per-cell colouriser, given the cell index within the row.
   * @returns {string} the rendered row.
   */
  row(row, colour) {
    let out = ''
    for (let cell = 0; cell < this.cells; cell += 1) {
      const glyph = String.fromCharCode(BRAILLE_BASE + this.bits[cell + row * this.cells])
      const paint = colour?.(cell)
      out += paint === undefined ? glyph : paint(glyph)
    }
    return out
  }
}
