import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        // Frozen legacy surface, machine-generated upstream (generator deleted
        // with server/) — excluded from coverage like other generated data.
        'src/plugin-permissions.ts',
        // Per-locale string tables are data, not executable code; the parity
        // specs import every locale, which would report them as 100% covered
        // and inflate the package number.
        'src/i18n/*/**',
      ],
    },
  },
});
