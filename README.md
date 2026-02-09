# @lxgicstudios/schema-diff

[![npm version](https://img.shields.io/npm/v/@lxgicstudios/schema-diff)](https://www.npmjs.com/package/@lxgicstudios/schema-diff)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)](https://www.npmjs.com/package/@lxgicstudios/schema-diff)

Compare two database schemas and find what's changed. Works with SQL files and JSON schema definitions. Shows added, removed, and modified tables, columns, types, and constraints. Highlights breaking changes so you don't ship something dangerous.

## Install

```bash
# Run directly with npx
npx @lxgicstudios/schema-diff old.sql new.sql

# Or install globally
npm install -g @lxgicstudios/schema-diff
```

## Usage

```bash
# Compare two SQL files
schema-diff db-v1.sql db-v2.sql

# Show only breaking changes
schema-diff old.sql new.sql --breaking-only

# Markdown output for PRs and docs
schema-diff old.sql new.sql --format markdown

# JSON output for piping to other tools
schema-diff old.json new.json --json

# Mix and match formats
schema-diff old.sql new.json --breaking-only --json
```

## Features

- **SQL parsing** - Handles CREATE TABLE statements for Postgres, MySQL, and SQLite
- **JSON schema support** - Compare JSON schema definitions too
- **Breaking change detection** - Flags dropped tables, removed columns, type changes, and nullable changes
- **Multiple output formats** - Terminal (colorful), Markdown (for PRs), JSON (for automation)
- **Zero dependencies** - Uses only Node.js builtins. Nothing to audit.
- **Fast** - Parses and diffs in milliseconds

## Options

| Option | Description |
|--------|-------------|
| `--format <type>` | Output format: `terminal` (default) or `markdown` |
| `--breaking-only` | Show only breaking/dangerous changes |
| `--json` | Output results as JSON |
| `--help` | Show help message |
| `--version` | Show version number |

## What Counts as Breaking?

- Dropped tables
- Removed columns
- Type changes (e.g., `INTEGER` to `TEXT`)
- Making a nullable column `NOT NULL`

## Supported File Formats

| Extension | Format |
|-----------|--------|
| `.sql` | SQL CREATE TABLE statements |
| `.json` | JSON schema definitions |

### JSON Schema Format

```json
{
  "tables": {
    "users": {
      "columns": {
        "id": { "type": "INTEGER", "primaryKey": true },
        "email": { "type": "VARCHAR(255)", "nullable": false, "unique": true },
        "name": { "type": "TEXT", "nullable": true }
      },
      "constraints": [
        { "name": "pk_users", "type": "PRIMARY KEY", "columns": ["id"] }
      ]
    }
  }
}
```

## License

MIT - [LXGIC Studios](https://lxgicstudios.com)
