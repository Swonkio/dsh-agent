/**
 * The one decision the launcher must get right: whether to show chrome.
 *
 * Chrome — the awakening and the HUD — is for a human sitting at a fresh
 * prompt. Every scripted path must get nothing: a `-p` one-shot, a pipe, a
 * `--json`/`--dump-config`/`--help` query. Getting this wrong would put
 * escape codes into the eval's captured output and into anyone's script, so it
 * is pulled out here where it can be tested exhaustively rather than left
 * inline in the bin.
 *
 * @module dsh-agent-ui/launch
 */

/** Flags that mean "not an interactive conversation". */
export const SCRIPTED_FLAGS = [
  '-p', '--print', '--json', '--dump-config', '--dump-default-config', '--help', '-h', '--version',
]

/**
 * @param {string[]} args - argv after the launcher.
 * @param {object} io - `{ stdoutTTY, stdinTTY }`.
 * @returns {boolean} whether to render chrome.
 */
export function wantsChrome(args, { stdoutTTY, stdinTTY } = {}) {
  if (!stdoutTTY || !stdinTTY) return false
  return !args.some(a => SCRIPTED_FLAGS.includes(a))
}
