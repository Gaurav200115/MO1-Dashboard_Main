/**
 * Option-writing skew, strike by strike.
 *
 * Where calls carry at least RATIO times the open interest of puts, writers have
 * committed to price staying below that strike — a resistance. The mirror case,
 * puts dominating calls, is a support. Total open interest is the basis, not the
 * day's change in it, so the reading is "where is the book positioned" rather
 * than "what moved today".
 */

export const OI_RATIO = 1.8;

export interface StrikeOi {
  strike: number;
  callOi: number;
  putOi: number;
}

export interface OiLevel {
  strike: number;
  kind: "support" | "resistance";
  callOi: number;
  putOi: number;
  /** call/put. Null where the denominator is zero — one-sided, not a ratio. */
  ratio: number | null;
}

export function oiLevels(strikes: StrikeOi[], ratio = OI_RATIO): OiLevel[] {
  const levels: OiLevel[] = [];

  for (const { strike, callOi, putOi } of strikes) {
    // A strike nobody holds carries no information, and would otherwise satisfy
    // both inequalities at once (0 >= 1.8 * 0).
    if (callOi + putOi <= 0) continue;

    const kind =
      callOi >= ratio * putOi ? "resistance" : putOi >= ratio * callOi ? "support" : null;
    if (!kind) continue;

    levels.push({
      strike,
      kind,
      callOi,
      putOi,
      ratio: putOi > 0 ? callOi / putOi : null,
    });
  }

  return levels;
}
