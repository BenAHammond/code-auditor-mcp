# Item 6 — Remove stale Spec 20 artifacts

**Gate**: grep clean.

## Artifacts removed

### Before close-out
- `src/config/profileResolver.ts` — deleted in v3.1.1 (CHANGELOG: "Spec-20: profile inheritance (speculative over-engineered; deleted in v3.1.1)")
- `tsconfig.json` line 38 `"src/config/profileResolver.ts"` — removed from exclude list
- `dist/config/profileResolver.d.ts.map` — deleted

### Verification at HEAD

```bash
# Source file is gone
ls src/config/profileResolver.ts
# → No such file or directory

# tsconfig exclude is clean
grep profileResolver tsconfig.json
# → (no output)

# dist/ has no leftovers
find dist -name "*profileResolver*"
# → (no output)

# Source tree grep (excluding CHANGELOG/GROUND-TRUTH which legitimately mention it)
grep -rn "profileResolver" --include="*.ts" --include="*.json" src/ | grep -v ".test."
# → (no output)
```

No stale Spec 20 artifacts remain in the source tree or build output. The CHANGELOG entry and GROUND-TRUTH.md section are the only references — both are intentional documentation, not stale code.
