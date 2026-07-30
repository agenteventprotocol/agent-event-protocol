# schemas/registry/ — the machine-readable registry

The registry is the single source of truth for AEP's closed sets
(AEP-0002 §6): SDK types are generated from it, `aep validate` enforces it,
and where spec prose and registry disagree, the registry is authoritative and
the disagreement is a defect (AEP-0002 Abstract).

| File | Enumerates |
|---|---|
| [`categories.json`](categories.json) | the thirteen type categories and their scope (AEP-0002 §3) |
| [`types.json`](types.json) | every registered type: `status` (`mandatory` \| `optional` \| `reserved`), `scope` (`session` \| `agent` \| `command`), payload-schema reference, one-line summary (AEP-0002 §4) |
| [`severity.json`](severity.json) | the six severity levels in order (AEP-0001 §8.1) |
| [`capture.json`](capture.json) | the four capture levels in order (AEP-0001 §8.2) |
| [`nack-reasons.json`](nack-reasons.json) | the `control.rejected` reason enum (AEP-0004 §3) |

A `deprecated` status value is reserved by policy
([GOVERNANCE §5.3](../../GOVERNANCE.md)) and enters `types.json` with the
first deprecating AEP.

## Registering a type

You do not need permission to *use* a new type: the vendor namespace
`x.{vendor}.{category}.{rest}` is open by design (AEP-0001 §6) and is the
recommended way to ship and prove a type before proposing it. Registration is
for promoting a type into the core namespace.

**1. Open an issue** on this repository proposing:

- the type name (`{category}.{rest}` — the category must be one of the
  thirteen in `categories.json`; changing the category set is a separate,
  heavier AEP per AEP-0002 §3);
- scope (`session` or `agent`) and one-line semantics;
- a payload sketch with an `x-aep-capture` annotation for every field
  (AEP-0002 §5.1) — content-bearing fields gated `redacted`+;
- the **fleet-observer argument** (AEP-0001 §3.2): why an observer watching
  many sessions it did not initiate acts on this type;
- evidence of need — the emitters or consumers that want it, ideally an
  `x.{vendor}.*` deployment already using the shape.

**2. Clear the bar.** A proposal advances when it fits an existing category,
overlaps no registered type's semantics, gates its content correctly, and
passes the fleet-observer test. Mandatory-set candidacy has a higher bar
(evidence in at least two independent source vocabularies, AEP-0002 §4.1) and
is a major-version change; optional core types are additive minor-version
changes (AEP-0002 §6).

**3. Land it as a Standards-Track AEP** (start from
[`spec/AEP-TEMPLATE.md`](../../spec/AEP-TEMPLATE.md)): the normative text,
the payload schema under [`schemas/types/`](../types), the `types.json` row,
and conformance fixtures land **in one change** — the SEP rule
([GOVERNANCE §2](../../GOVERNANCE.md)). Generated SDK types regenerate from
the registry, so a registration is complete only when the codegen diff gate
is green.

The promotion path end to end: `x.{vendor}.*` extension → `experimental`
core (registered, flagged) → core (AEP-0002 §6); stability semantics for
each stage are defined in [GOVERNANCE §5](../../GOVERNANCE.md).
