/**
 * LP Study — backend-dependent feature (Agent Meridian removed).
 * Returns a stub response since the server-side API is no longer available.
 */
export async function studyTopLPers({ pool_address, limit = 4 }) {
  return {
    pool: pool_address,
    message: "LP study isn't available — the Agent Meridian backend has been removed.",
    patterns: {},
    lpers: [],
  };
}
