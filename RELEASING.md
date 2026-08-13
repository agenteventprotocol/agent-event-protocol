# Releasing

The release **procedure** for the protocol: the spec, schemas, and
conformance suite in this repository. The versioning **policy** it executes
(the two version tracks, compatibility commitments, pre-release scheme,
changelog discipline) is stated once for the whole organization in
[VERSIONING.md](VERSIONING.md); changing that policy after v0.1 is itself a
governance decision (GOVERNANCE.md), not an edit.

The SDK and reference packages release on their own cadence, from their own
repositories; see each repository's `RELEASING` notes. This document governs
the protocol release only.

## 1. Versioning policy (canonical statement elsewhere)

In brief, from [VERSIONING.md](VERSIONING.md): the protocol version
(`aep: "0.1"`) names the spec set, schemas, and conformance fixtures as one
unit and tags as `v0.1`, `v0.2`, … in this repository. Pre-1.0, each `0.x`
minor is the breaking boundary and there are no protocol patch releases.
The packages (`@agenteventprotocol/sdk`, `agenteventprotocol`) version independently under
SemVer 2.0.0 and **declare** which protocol version(s) they implement;
package tags live in their own repositories. Nothing in the procedure below
changes that policy.

## 2. v0.1 protocol release procedure

Steps marked **[M]** are maintainer-run (tagging and any registry action are
never automated from this repository). Everything else can be prepared by a
contributor but is verified before tagging.

**Preconditions (all evidence-based, no calendar):**

1. The mandatory-14 taxonomy (AEP-0002) has had its freeze review; the
   mandatory set is the last cheap thing to change.
2. Bridge round-trips (AEP-0005), scope, and schema-generated SDK types are
   re-confirmed on the tag candidate.
3. `./ci.sh` green on a fresh clone.
4. Registry availability confirmed **[M]**: npm `@agenteventprotocol` scope, PyPI `agenteventprotocol`,
   and the GitHub organization.

**Release steps:**

1. Roll `CHANGELOG.md`: `[Unreleased]` → `[0.1] — <date>`; start a fresh
   `[Unreleased]`.
2. Set spec front-matter statuses (per GOVERNANCE.md §1): AEP-0001, 0002,
   0003, 0005 → `Final`; AEP-0004 keeps the status the freeze review assigns
   it (the control profile is `experimental` and is expected to graduate after
   v0.1). AEP-0006's status follows its own review. AEP-0007 (the
   message/stream sub-profile) follows its own review as well; a Draft
   sub-profile does not block the protocol tag.
3. Re-run `./ci.sh` on that commit.
4. Tag: `git tag -a v0.1 -m "AEP 0.1"` and push the tag **[M]**.
5. GitHub release from the tag, notes = the 0.1 CHANGELOG section **[M]**.
6. The SDK and reference repositories cut their own releases against the
   `v0.1` schemas, following their own procedures.

**If anything fails after tagging:** never move or delete a pushed tag; fix
forward (`v0.2` for protocol defects) and record what happened in the
CHANGELOG.
