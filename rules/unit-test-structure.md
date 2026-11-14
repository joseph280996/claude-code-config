# Unit test structure: mirrored path, one test file per source file

Applies to: JS/Node.js/TS/TSX unit tests in projects with a `src/` tree. E2E tests (Cypress, Protractor, k6) are out of scope. For extend-vs-create decisions, see `test-reuse.md`.

## When this rule binds

Binds when the project has a `tests-new/` or `tests/` root, or has no test files yet — including projects that also keep a legacy `tests/` tree beside `tests-new/`. Defer to the project only when it uses a different convention (colocated `*.spec.*` files next to sources, `__tests__/`).

## Location

Test files live in a mirrored tree under `tests-new/`. Use `tests/` only when no `tests-new/` folder exists. When both `tests-new/` and `tests/` exist, always put tests in `tests-new/` — never add new tests to the `tests/` tree. The mirror path equals the source path relative to `src/`:

- `src/tickets/order/orderState.ts` → `tests-new/tickets/order/orderState.test.ts`

## Naming

`<file_name>.test.<ext>` — same base name as the source file, and the extension matches the source: `foo.test.js`, `bar.test.ts`, `Baz.test.tsx`.

## One test file per source file

All tests for a source file go in its single mirrored test file. A source file that needs its tests split across several test files is too large: splitting the source logic is follow-up work for the user — flag it, do not do it now, and keep the tests in the one file. This overrides the "file too large to navigate" exemption in `test-reuse.md` for JS/TS unit tests.

If a test file for the source already exists at a non-mirrored path (for example in a legacy `tests/` tree) and the project has no `tests-new/`, extend it there. Do not create a second file, and do not move the existing one. When `tests-new/` exists, put the tests in the mirrored `tests-new/` file, even if a legacy `tests/` file for the source exists. Add no new tests to that legacy file, and do not move or delete it; it does not count as a second test file. If the existing non-mirrored file is inside `tests-new/`, extend it there.

## Exemptions

- Fixtures, helpers, and shared setup that cover no single source file: place freely in the test root; mirroring is not required.
- Compiled artifacts beside source test files (`.test.js.map`, compiled `.js` next to `.ts`) are output, not tests — never edit them; they do not affect placement of the source test file.
