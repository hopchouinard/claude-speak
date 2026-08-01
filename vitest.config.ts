import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // Worktrees live under .worktrees/ (see .gitignore) and each one holds a
    // full copy of test/, so the default glob collects every test once per
    // live worktree. During the 2.0.0 work that turned 296 tests into 592.
    //
    // The duplicate count is only the visible symptom. The real hazard is that
    // a worktree on an older or half-finished branch makes this checkout's
    // suite fail for reasons that have nothing to do with the code being
    // tested — and the failure names a path most people do not look at twice.
    //
    // Spread configDefaults.exclude rather than replacing it: setting `exclude`
    // overrides the built-in list, which would put node_modules and dist back
    // in scope.
    exclude: [...configDefaults.exclude, '.worktrees/**'],
  },
});
