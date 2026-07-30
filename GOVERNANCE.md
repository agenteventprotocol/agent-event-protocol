# Governance

This document operationalizes the AEP process defined normatively in
[AEP-0001 §13](spec/AEP-0001-core-and-envelope.md). Where this document and
AEP-0001 disagree, **AEP-0001 wins**: fix the disagreement with a process AEP.

## 1. Documents: types and statuses

Specification changes happen through **AEP-numbered documents** (`AEP-XXXX`),
written from the [proposal template](spec/AEP-TEMPLATE.md).

**Types**

| Type | Meaning |
|---|---|
| Standards Track — Core | Changes to the envelope, taxonomy, ordering/replay, or conformance contract |
| Standards Track — Binding | New or changed transport bindings and lifecycle rules |
| Standards Track — Annex | Bridge mappings and other normative annexes |
| Informational | Guidance, surveys, rationale: no normative force |
| Process | Changes to this process itself |

**Statuses**

```
Draft → Review → Accepted → Final
              ↘ Rejected / Withdrawn
```

- **Draft**: under active development; normative wording may change.
- **Review**: feature-complete; soliciting implementation feedback.
- **Accepted**: requirements met (see §2); implementations may ship behavior.
- **Final**: shipped in a tagged protocol version; changes require a new AEP.

## 2. Requirements for Accepted (the SEP rule)

Adopted from MCP's SEP process. A Standards-Track AEP is not Accepted until it
has **all** of:

1. **Motivation, specification, rationale, and backward-compatibility**
   sections (the template enforces this).
2. **A prototype**: working code exercising the proposed behavior.
3. **Conformance fixtures**: every accepted specification change MUST land
   with fixtures in [conformance/](conformance/) **in the same change**. The
   dual runners (`conformance/run.py`, `conformance/run.js`) are the arbiter:
   `./ci.sh` green is a merge precondition, not a courtesy.
4. **A sponsor**: required once co-maintainers exist; until then the
   maintainer sponsors by default.

Amendments to already-settled decisions are never silent: each is proposed as
a numbered AEP and merged with its evidence, rationale, and resolution recorded
in the AEP itself and the [CHANGELOG](CHANGELOG.md).

## 3. The governance firewall (normative)

**No behavior ships in the reference relay or any reference implementation
before the corresponding specification change is Accepted.** Spec first, code
second, always.

The reference relay has a **frozen feature ceiling**: ingest, attr-match
subscription, fan-out, bounded replay, token auth: *nothing else, ever*.
Proposals that would raise it are out of scope by
construction. The scope court for new event granularity is the
**fleet-observer test** (AEP-0001 §3.2): if a fleet observer wouldn't act on
it, it is not a core event.

## 4. Versioning

Evolution within a major version is **additive only**: new event types, new
OPTIONAL envelope attributes, new capabilities. Core attributes and registered
types are never repurposed or removed within a major. A breaking change
requires a major version and a superseding Standards-Track AEP
(AEP-0001 §11). The three sanctioned extension surfaces are vendor types
(`x.{vendor}.*`), extension attributes, and `capabilities.experimental`;
the promotion path is extension → experimental core → core.

## 5. Stability, deprecation, and graduation

### 5.1 Stability levels

Every normative surface is either **stable** or **`experimental`**. Stable
surfaces carry the full §4 compatibility promise. `experimental` surfaces
(the control profile (AEP-0004), the identity document (AEP-0003 §8.3), and
anything advertised under `capabilities.experimental`) may change or be
withdrawn without a major version; implementations adopt them knowingly, and
consumers MUST NOT hard-depend on them (a peer may lack them entirely).

### 5.2 Graduation (`experimental` → stable)

A surface graduates through a Standards-Track AEP that flips the marker and
records the evidence. The graduating AEP is not Accepted until **all** of:

1. **Two independent implementations** exercise the surface in real use;
   independent meaning separately maintained codebases, not two artifacts of
   the same stack.
2. **Named prerequisites resolved.** Every open question the surface's own
   spec text ties to graduation is settled through the AEP process. For the
   control profile that means, concretely: the relay-behalf rejection audit
   gap (AEP-0004 §8) is resolved (as protocol surface or as an explicit,
   normatively stated exception) and an authorization posture is decided
   (AEP-0004 §4.3): a standardized policy surface, or deployment-owned
   authorization stated normatively rather than by omission.
3. **A quiet interval.** At least one protocol release ships with the
   surface's conformance fixtures unchanged in meaning (additions are fine;
   semantic churn resets the clock).
4. The usual SEP rule (§2): the graduating AEP lands with fixtures that pin
   the now-stable semantics.

### 5.3 Deprecation

Deprecation is a marker, never a removal. Within a major version a registered
type or core attribute is **never** removed or repurposed (§4, AEP-0001 §11);
a deprecating AEP instead:

1. marks the registry entry deprecated (the registry's status vocabulary
   gains that value with the first such AEP),
2. names the replacement, which must be registered in the same or an earlier
   change, and
3. records the migration note in the spec text and CHANGELOG.

Deprecated types keep validating, keep their schemas, and remain covered by
unknown-type tolerance for the remainder of the major; deprecation changes
recommendations, not validity. Removal happens only at a major version
boundary, carried by the superseding AEP.

### 5.4 Wire-version coexistence

The envelope's `aep` attribute, the `hello` version negotiation
(AEP-0003 §4.1), and the discovery document's `aep` array are the coexistence
mechanism: a party MAY advertise several versions (e.g. `["0.2", "0.1"]`) and
serve each connection with the one version that connection selected;
connectionless bindings carry the version on every Event.

Pre-1.0, each `0.x` minor is the breaking boundary (RELEASING.md §1), so migration windows are
exactly dual-advertising windows: emitters keep emitting the version they
were built for, consumers accept any version they support.

Document statuses (§1) move independently of the wire version: an AEP can reach Accepted while
the wire version stays put, folding into the next tag.

### 5.5 Changelog discipline

[CHANGELOG.md](CHANGELOG.md) follows Keep a Changelog: an `Unreleased`
section accumulates between tags and becomes the tag's notes; every
user-visible change lands in the same commit as its changelog line; normative
entries name their AEP. This is the practiced convention, stated so it can be
held.

## 6. Repository shape

AEP is developed across a small organization of repositories. **This repository
is the standard**: the specification suite (`spec/`), the schema registry and
codegen (`schemas/`), the conformance fixtures and runners (`conformance/`), and
the explanatory docs (`docs/`). These four version together in one repository
because the SEP rule (§2.3) requires every normative change to land **with** its
conformance fixtures in the same commit: spec, schemas, and fixtures are
inseparable by design.

The runnable implementations live in sibling repositories: the reference stack
(relay, CLI, adapters, bridges, MCP server, demo) and the TypeScript and Python
SDKs. These repositories release on their own cadence, decoupled from the
protocol version (see [RELEASING.md](RELEASING.md) §1). They regenerate their committed types
from this repository's schemas at a pinned revision and verify the result in CI;
they never change what the spec requires without a corresponding AEP here first.

## 7. Roles

- **Maintainer**: currently one; owns naming/registry decisions, releases,
  and outreach.
- **Co-maintainers**: added by maintainer invitation; once ≥1 exists, the
  sponsor requirement (§2.4) activates and Accepted requires a second
  maintainer's review.
- **Contributors**: anyone, via the process in
  [CONTRIBUTING.md](CONTRIBUTING.md).

## 8. Licenses

- Code, schemas, and generated types: **Apache-2.0** ([LICENSE](LICENSE)).
- Specification prose (`spec/*.md`): **CC-BY 4.0** ([spec/LICENSE](spec/LICENSE)).

Contributions are accepted under the same licenses (inbound = outbound). The SDK
and reference repositories are Apache-2.0 throughout.

**NOTICE file: no. Per-file license headers: no.** Apache-2.0 §4(d) requires a
NOTICE file only when the *upstream* work ships one to propagate; this project
has no vendored third-party code carrying its own NOTICE, so there is nothing
to propagate; a NOTICE file here would be inert boilerplate, not a real
attribution record.

Per-file SPDX/copyright headers are optional under Apache-2.0 (unlike, e.g., MPL) and the codebase already uses a one-line
descriptive banner per file (purpose + governing spec section) in place of
license boilerplate; adding headers would duplicate the root LICENSE without
adding legal weight, and would conflict with that existing convention.

Revisit only if a future dependency is vendored in-tree (at that point its own NOTICE
terms govern, and this decision should be re-examined).
