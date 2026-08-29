# Confirmation foundation (internal)

This first extraction adds the core confirmation store, canonical execution-intent
model, bounded config provenance and content fingerprints. It does not activate
confirmation tokens in MCP. Existing operations still use their current
confirm-only execution flow; neither the server nor production operation
implementations construct a confirmation runtime.

The store is process-local: a random 256-bit key authenticates a 128-bit nonce,
canonical intent and a separate capability MAC. Tokens are opaque, one-time and
invalid after restart. There is no wall-clock TTL. Consumed capabilities are
retained until restart, so memory grows with accepted/retired capabilities;
this foundation does not introduce an eviction or quota policy.

Internal authorization binds the tool, resolved profile, config source and exact
execution intent. It returns a private receipt for later content execution.
Receipts and fingerprints must not become tool response fields. Input paths,
contents and parser details stay out of config error responses. loadConfig keeps
its existing return type and error behavior; loadConfigDocument adds internal
source provenance obtained from the same bounded descriptor read.

Fingerprinting is not immutable execution. File input reads are bounded at 16 MiB;
config reads remain bounded at 1 MiB. Payload snapshots and their consumers belong
to later parts of the split. Credential-only inputs remain freshness guards.
The foundation does not attest SSH effective hosts, Docker contexts or volume
generations, and does not provide filesystem CAS/unlink isolation.

Direct library tests cover canonicalization, malformed/replayed/foreign tokens,
retirement, concurrent consumption, contextual generations, exclusive scopes,
source provenance and non-disclosing input errors. The MCP boundary regression
deliberately retains the old wire contract; update it in the atomic activation
PR together with all 23 mutation-capable tools, prompts and invocation guidance.

Planned consumers: immutable-content executor, ordinary operations, Docker
identity hardening and sensitive/composite workflows. Until these are integrated,
this library is internal infrastructure, not a publicly enabled protection.
