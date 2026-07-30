# Versioning

The versioning policy for AEP and every repository in the
`agenteventprotocol` organization. This is the canonical statement: the
satellite repositories (`typescript-sdk`, `python-sdk`, `reference`,
`mission-control`) point here and add only what is specific to their own
artifact. The policy is a public compatibility commitment; changing it after
the first protocol tag is a governance decision under
[GOVERNANCE.md](GOVERNANCE.md), not an edit.

The release *procedure* (how a version actually ships) lives in
[RELEASING.md](RELEASING.md) (protocol) and in each package repository's
own `RELEASING.md` (packages).

## 1. The two version tracks

AEP deliberately runs two version tracks, and they are **not** coupled:

1. **The protocol version**: the wire contract (`aep: "0.1"` on every
   event). One version names the spec set, the schemas, and the conformance
   fixtures as a unit.
2. **Package versions**: ordinary [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html)
   for the published packages (`@aep/sdk` on npm, `aep-sdk` on PyPI),
   decoupled from the protocol version.

Coupling them would force a package release for every spec release and
forbid package majors between spec releases. Instead, every package
**declares** which protocol version(s) it implements (§4). At the first
release everything happens to align at 0.1; that is a coincidence, not the
policy.

## 2. The protocol version

The protocol version is the `aep` attribute every event carries, and it
names, as one unit:

- the specification set (`spec/AEP-*`) at the statuses
  [GOVERNANCE.md §1](GOVERNANCE.md) assigns,
- the schema registry (`schemas/`, whose `$id`s carry the version path,
  e.g. `aep://schemas/0.1/aep-event.schema.json`; the envelope schema pins
  the version as a constant),
- the conformance fixtures that make its claims testable.

Rules, in order of project life:

- **Before the first tag**: no compatibility obligation exists; normative
  changes still require the SEP rule (an AEP + conformance fixtures in the
  same change, [GOVERNANCE.md §2](GOVERNANCE.md)).
- **Pre-1.0, from `v0.1` on**: [GOVERNANCE.md §4](GOVERNANCE.md) applies
  with the standard SemVer reading of the 0 major: **each `0.x` minor is
  the breaking boundary**. An incompatible wire change ships only at the
  next `0.x` tag, carried by a superseding or amending Standards-Track AEP.
  There are no patch releases of the protocol: editorial fixes to spec text
  don't bump the version, normative fixes do.
- **From 1.0**: additive only within a major: new event types, new
  OPTIONAL envelope attributes, new capabilities; core attributes and
  registered types are never repurposed or removed. Anything that would
  invalidate a conforming 1.x emitter or consumer requires a new major and
  a superseding Standards-Track AEP. Consumers carry the matching
  obligation: tolerate unknown types and attributes.
- **Stability levels ride inside the version**: every normative surface is
  `stable` or `experimental` ([GOVERNANCE.md §5.1](GOVERNANCE.md));
  `experimental` surfaces (e.g. the control profile) may change without a
  major. Graduation and deprecation follow §5.2–§5.3; deprecation is a
  marker, never a removal within a major.
- **Coexistence on the wire**: implementations state the protocol versions
  they speak (the `hello` negotiation and the discovery document's version
  array, [GOVERNANCE.md §5.4](GOVERNANCE.md)), never "latest". A party MAY
  advertise several versions at once; pre-1.0 migration windows are exactly
  such dual-advertising windows.

Protocol releases are annotated tags `v0.1`, `v0.2`, … in this repository.
A pushed tag is never moved or deleted; defects are fixed forward.

## 3. Package versions: SemVer 2.0.0

The published packages follow [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html),
with these commitments:

- **A declared public API.** SemVer is meaningless without one (SemVer §1).
  Each package's `RELEASING.md` states exactly what its public API is,
  as a rule: everything importable from the package entry point, including
  the generated protocol types; internals, tests, and vendored test
  fixtures are not public API.
- **MAJOR**: incompatible changes to that public API. **MINOR**: added
  functionality, backward compatible. **PATCH**: backward-compatible
  fixes.
- **Pre-1.0 honesty**: while the major is 0, a minor bump may be breaking.
  Every breaking change (pre- or post-1.0) lands with a CHANGELOG entry
  that says what breaks and how to migrate.
- **Generated code is versioned like hand-written code.** The SDKs commit
  types generated from this repository's schemas at a pinned revision; a
  regeneration that changes the public surface is versioned by the same
  SemVer rules, and its CHANGELOG entry names the schema change that drove
  it.
- **Pre-release identifiers per ecosystem**: npm uses `-dev`
  (`0.1.0-dev`), PyPI uses [PEP 440](https://peps.python.org/pep-0440/)
  developmental releases (`0.1.0.dev0`), the same version core, suffixed
  by each ecosystem's native convention. Release automation asserts tag ⇔
  manifest equality before publishing.
- **The release is the tag.** Package tags (`v0.1.0`, …) live in the
  package repositories; nothing publishes without one, and the sibling
  SDKs run a version-core agreement check before tagging (each package
  repository's `RELEASING.md` documents it).

## 4. Compatibility between the tracks

A package or application declares what it implements, and CI enforces that
the declaration is real:

- **Declaration**: a compatibility line in the README ("implements
  AEP 0.1") and the version array sent in `hello`. A package MAY implement
  several protocol versions at once.
- **Enforcement, before a registry exists**: every satellite pins this
  repository at an exact commit (a `SPEC_VERSION` file), vendors a
  byte-for-byte snapshot (schemas/conformance, or regenerated types), and
  runs a CI job that re-clones the pin and fails on any drift.
  `mission-control` applies the same mechanism one layer up (an
  `SDK_VERSION` pin on the TypeScript SDK).
- **At a protocol release**: the satellites cut their own releases against
  the protocol tag, updating their pins and compatibility lines in the
  same change.

## 5. Repositories that are not packages

`reference` and `mission-control` ship no registry artifacts; they release
as **tagged wholes** on their own SemVer lines when the protocol releases.
Their internal manifests carry the same pre-release version core as the
SDKs (`0.1.0-dev`) purely for consistency and are never published; version
strings that appear on their wire surfaces (e.g. an MCP server's
`serverInfo`) report that same line.

`dotgithub` (the organization profile) carries no version.

## 6. Changelog discipline

Every repository keeps a [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
`CHANGELOG.md`: an `[Unreleased]` section accumulates between tags and
becomes the tag's release notes; every user-visible change lands in the
same commit as its changelog line; normative entries name their AEP
([GOVERNANCE.md §5.5](GOVERNANCE.md)).
