// One definition of "this bug claims verification", shared by every check that
// reads the ledger.
//
// MEASURED 2026-11-27 (audit A3GateRevival): three different predicates decided
// the same concept and could disagree:
//
//   ledger.mjs:89   `b.verified === true || /^\d{4}-\d\d-\d\d$/.test(b.verified)`
//                   -> requires an `_evidence` artifact that exists and is clean
//   artifacts.mjs:19 `b.state === 'verified' || b.state === 'arm-verified'`
//                   -> requires a fresh RED arm artifact + a reachability record
//   receipt.mjs       `b.state === 'fixed' && b.verified !== true`
//                   -> decides what to print as FIXED, NOT VERIFIED
//
// A row with `state: 'fixed', verified: true` was counted by `ledger-evidence`,
// skipped by `verified-artifacts`, and excluded from the FIXED-NOT-VERIFIED list:
// an evidence claim with no artifact binding and no warning anywhere. The two
// predicates are the SAME claim seen from two sides, so a row must satisfy both
// or neither, and `ledger-evidence` now refuses the divergence.

// "The ledger says this was verified." A boolean or a YYYY-MM-DD date both count:
// the ledger uses the date form when the proof is a dated run.
export function isVerifiedClaim(bug) {
  return bug.verified === true || /^\d{4}-\d\d-\d\d$/.test(String(bug.verified || ''));
}

// "The ledger's state says there is an artifact to bind." Only these two states
// promise `arms_artifact` + `reachability_artifact`; every other state is work in
// progress and must not be silently counted as verified.
export function carriesArtifactBinding(bug) {
  return bug.state === 'verified' || bug.state === 'arm-verified';
}

// The port of the same question to one string, for a refusal message that names
// both sides instead of making the reader re-derive them.
export function describeVerification(bug) {
  return `state=${bug.state}, verified=${JSON.stringify(bug.verified === undefined ? null : bug.verified)}`;
}
