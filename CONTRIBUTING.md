# Contributing to AEP

Thanks for your interest. AEP is **spec-first**: the specification suite in
[spec/](spec/) is the product; the reference code (in sibling repositories)
exists to prove the spec is implementable. That ordering shapes everything
below.

**This repository holds the standard**: spec, schemas, conformance fixtures,
and docs. Code contributions to the runnable implementations go to their own
repositories:

- Reference stack (relay, CLI, adapters, bridges, MCP server, demo):
  [`agenteventprotocol/reference`](https://github.com/agenteventprotocol/reference)
- TypeScript SDK (`@aep/sdk`): [`agenteventprotocol/typescript-sdk`](https://github.com/agenteventprotocol/typescript-sdk)
- Python SDK (`agenteventprotocol`): [`agenteventprotocol/python-sdk`](https://github.com/agenteventprotocol/python-sdk)

## Ground rules

1. **Spec changes go through the AEP process.** Anything that changes
   normative text (MUST/SHOULD/MAY, the envelope, type registry, bindings,
   bridge mappings) needs an AEP-numbered proposal; see
   [GOVERNANCE.md](GOVERNANCE.md) and the [template](spec/AEP-TEMPLATE.md).
   Editorial fixes (typos, broken links, clearer non-normative prose) are
   ordinary PRs.
2. **Normative change ⇒ conformance fixtures, same PR.** The runners in
   [conformance/](conformance/) are the arbiter. A PR that changes what the
   spec requires but not what the fixtures test will not be merged.
3. **`./ci.sh` must be green.** It runs the schema/codegen diff gate, the
   conformance runner, and a strict typecheck of the generated TypeScript; a
   second docs job (`docs/check-docs.sh`) runs the offline documentation QA
   gate.
4. **Generated code is never edited by hand.** `schemas/gen/**` (TypeScript,
   pydantic, AsyncAPI) is produced by `schemas/codegen/generate.py`. Change
   the source schemas in `schemas/` and regenerate; CI diffs the output. The
   same rule covers the generated docs-site pages under
   `docs/specification/draft/` and `docs/community/`: edit `spec/*.md` or the
   root governance files and re-run `node docs/render-site.js`.
5. **Scope is frozen.** The relay feature ceiling and the fleet-observer test
   (GOVERNANCE.md §3) are not open for negotiation pre-1.0. Proposals for new
   event types must pass the fleet-observer test.

## Dev setup

Node ≥ 22 (global `fetch`/`WebSocket`) and Python ≥ 3.10.

```bash
./ci.sh                        # everything; also runnable piecewise:
bash schemas/ci-check.sh       # schema metaschema + registry + codegen diff gate
python3 conformance/run.py     # the conformance runner
bash docs/check-docs.sh        # offline docs QA gate
```

The Python-side codegen and conformance steps use
[uv](https://docs.astral.sh/uv/) to provision `jsonschema` (see
`.github/workflows/ci.yml`).

### Documentation

`docs/` is a [Mintlify](https://mintlify.com) site (`docs/docs.json` holds
the navigation). Preview it locally with `npx mint dev` from `docs/`, and
check site links with `npx mint broken-links`. Both need the network; the
offline gate above is the floor CI never sinks below. Pages carry `title`
and `description` frontmatter, omit an in-body H1, and link root-relative
(`/concepts/what-and-why`); conventions live in [docs/STYLE.md](docs/STYLE.md).
The pages under `docs/specification/draft/` and `docs/community/` are
generated (rule 4 above); CI fails on stale mirrors.

## Proposing a change

- **Bug in code** (a reference implementation disagreeing with the spec): open
  an issue in that implementation's repository with a reproducing event or
  fixture. The spec wins; the code changes.
- **Bug in a fixture**: treat as a spec question. Fixtures encode normative
  claims. Cite the AEP section you believe the fixture contradicts.
- **New capability**: open an issue sketching motivation first. If it survives
  the fleet-observer test and scope discussion, write an AEP from the
  [template](spec/AEP-TEMPLATE.md) as `spec/AEP-XXXX-short-title.md` (next free
  number) with status `Draft`.
- **Vendor mapping** (new agent runtime → AEP): extend AEP-0002 Annex A via an
  ordinary AEP; the adapter itself lives in the reference repository.

## Style

- Spec prose: RFC 2119/8174 keywords, one normative statement per sentence
  where possible, examples marked non-normative. Senior-technical-writing bar:
  if a sentence can be misread, it will be.
- Code: match the file you're in. The reference implementations are
  dependency-light on purpose.
- Commits: imperative subject, body explains *why*; reference AEP sections
  (e.g. "AEP-0003 §6") rather than restating them.

## Licensing of contributions

Code and schemas: Apache-2.0. Spec prose: CC-BY 4.0. Submitting a PR asserts
you have the right to contribute under those terms (inbound = outbound; no
CLA).
