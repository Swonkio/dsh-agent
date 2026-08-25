/**
 * dsh-agent-ui — dsh-agent's terminal identity.
 * @module dsh-agent-ui
 */
export { colorDepth, PALETTE, paint, heat } from './theme.js'
export { buildGraph, layout, terms, labelOf } from './graph.js'
export { Canvas } from './canvas.js'
export { gatherStatus, ago } from './status.js'
export { renderHud } from './hud.js'
export { renderThemeMap } from './themecheck.js'
export { wordmark, meter, panel, spark } from './render.js'
export { frame, playBoot } from './boot.js'
export { wantsChrome, SCRIPTED_FLAGS } from './launch.js'
