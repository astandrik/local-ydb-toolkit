# Cleanup helper

This directory owns the source for the bundled `linux/amd64` storage-cleanup helper. The compiled
asset and its integrity manifest live under `packages/core/src/native/cleanup-helper/linux-amd64/`
so the core build can copy them into `dist` and the MCP package can vendor them recursively.

The helper treats `/cleanup-root` as a trusted bind-mount boundary and accepts only a normalized
relative directory target beneath it. It opens one path component at a time with `O_NOFOLLOW`,
pins traversal to directory file descriptors, compares `STATX_MNT_ID` for every opened directory,
and atomically claims the verified target under a private randomized name directly beneath the
trusted root before deleting any entry. A failed cleanup restores the claimed target only when its
original parent can still be resolved to the same directory beneath the root; otherwise remaining
data stays at the reported claim path. The root itself cannot be selected. There is no path-based
or shell fallback when `statx` or `renameat2(RENAME_NOREPLACE)` is unavailable.

The component-wise algorithm is intentional: Docker Desktop's amd64 emulation on Apple Silicon
returns `ENOSYS` for `openat2`, while `statx` mount IDs and atomic `openat(O_NOFOLLOW)` are available
in the same official-image runtime.

The configured root and the helper's randomized claim namespace are trusted to remain stable for
the duration of one confirmed cleanup. A process with equivalent filesystem privileges that can
deliberately discover and mutate that private namespace is outside the confinement boundary.

From the repository root:

```bash
npm run cleanup-helper:build          # regenerate the committed binary and manifest
npm run cleanup-helper:asset-check    # fast source/binary/manifest integrity check
npm run cleanup-helper:rebuild-check  # pinned Docker rebuild and byte comparison
npm run cleanup-helper:test           # native confinement regression suite
```

The build uses the digest-pinned compiler image recorded in `scripts/cleanup-helper/config.mjs` and
runs with a read-only filesystem and no container network access.
