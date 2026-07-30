---
name: Protocol proposal
about: Propose a new feature or change to the AEP specification
title: "[PROPOSAL] "
labels: proposal
assignees: ''
---

## Summary

Brief description of what you're proposing.

## Motivation

Why is the current specification insufficient? Cite concrete examples: an adapter that cannot express something, a consumer forced to guess, a mapping that loses information. For new event types, explicitly argue the fleet-observer test (AEP-0001 §3.2).

## Does this touch the mandatory type set?

- [ ] Yes, proposes adding/changing/removing from the 14 mandatory types (AEP-0002)
- [ ] No, only touches optional aspects or new bindings/bridges

## Next steps

New protocol proposals follow the AEP process defined in [GOVERNANCE.md](../../GOVERNANCE.md) and use the [proposal template](../../spec/AEP-TEMPLATE.md). A maintainer will guide you through:

1. Writing a formal AEP-XXXX proposal in `spec/AEP-XXXX-short-title.md`
2. Implementation and conformance fixtures (the SEP rule: §2 of GOVERNANCE.md)
3. Review and acceptance

Start with the template and see GOVERNANCE.md §1–2 for requirements and process.
