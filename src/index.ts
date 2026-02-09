#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

// ── ANSI Colors ──
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
};

const VERSION = "1.0.0";

// ── Types ──
interface Column {
  name: string;
  type: string;
  nullable: boolean;
  defaultVal: string | null;
  primaryKey: boolean;
  unique: boolean;
}

interface Constraint {
  name: string;
  type: string;
  columns: string[];
  references?: string;
}

interface Table {
  name: string;
  columns: Map<string, Column>;
  constraints: Constraint[];
}

interface Schema {
  tables: Map<string, Table>;
}

interface Diff {
  addedTables: string[];
  removedTables: string[];
  changedTables: TableDiff[];
}

interface TableDiff {
  name: string;
  addedColumns: Column[];
  removedColumns: Column[];
  changedColumns: ColumnChange[];
  addedConstraints: Constraint[];
  removedConstraints: Constraint[];
}

interface ColumnChange {
  name: string;
  oldType: string;
  newType: string;
  oldNullable: boolean;
  newNullable: boolean;
  oldDefault: string | null;
  newDefault: string | null;
  breaking: boolean;
}

// ── SQL Parser ──
function parseSQL(content: string): Schema {
  const tables = new Map<string, Table>();
  // Normalize: remove comments, collapse whitespace
  const cleaned = content
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\r\n/g, "\n");

  const createRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([\s\S]*?)\)\s*;/gi;
  let match: RegExpExecArray | null;

  while ((match = createRegex.exec(cleaned)) !== null) {
    const tableName = match[1].toLowerCase();
    const body = match[2];
    const columns = new Map<string, Column>();
    const constraints: Constraint[] = [];

    const lines = body.split(",").map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      const upper = line.toUpperCase().trim();

      // Table-level constraints
      if (upper.startsWith("PRIMARY KEY")) {
        const colMatch = line.match(/\(([^)]+)\)/);
        if (colMatch) {
          constraints.push({
            name: `pk_${tableName}`,
            type: "PRIMARY KEY",
            columns: colMatch[1].split(",").map((c) => c.trim().replace(/["`]/g, "").toLowerCase()),
          });
        }
        continue;
      }

      if (upper.startsWith("UNIQUE")) {
        const colMatch = line.match(/\(([^)]+)\)/);
        if (colMatch) {
          constraints.push({
            name: `uq_${tableName}_${colMatch[1].replace(/\s/g, "")}`,
            type: "UNIQUE",
            columns: colMatch[1].split(",").map((c) => c.trim().replace(/["`]/g, "").toLowerCase()),
          });
        }
        continue;
      }

      if (upper.startsWith("FOREIGN KEY") || upper.startsWith("CONSTRAINT")) {
        const fkMatch = line.match(/FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+["`]?(\w+)["`]?\s*\(([^)]+)\)/i);
        if (fkMatch) {
          constraints.push({
            name: `fk_${tableName}_${fkMatch[1].trim().replace(/["`]/g, "")}`,
            type: "FOREIGN KEY",
            columns: fkMatch[1].split(",").map((c) => c.trim().replace(/["`]/g, "").toLowerCase()),
            references: `${fkMatch[2].toLowerCase()}(${fkMatch[3].toLowerCase()})`,
          });
        }
        continue;
      }

      if (upper.startsWith("CHECK") || upper.startsWith("INDEX")) {
        continue;
      }

      // Column definition
      const colMatch = line.match(/^["`]?(\w+)["`]?\s+(\w[\w() ,]*)/i);
      if (colMatch) {
        const colName = colMatch[1].toLowerCase();
        const colType = colMatch[2].trim().toUpperCase();
        const isPK = upper.includes("PRIMARY KEY");
        const isUnique = upper.includes("UNIQUE");
        const isNullable = !upper.includes("NOT NULL") && !isPK;
        const defMatch = line.match(/DEFAULT\s+([^ ,]+)/i);

        columns.set(colName, {
          name: colName,
          type: colType,
          nullable: isNullable,
          defaultVal: defMatch ? defMatch[1] : null,
          primaryKey: isPK,
          unique: isUnique,
        });
      }
    }

    tables.set(tableName, { name: tableName, columns, constraints });
  }

  return { tables };
}

// ── JSON Schema Parser ──
function parseJSONSchema(content: string): Schema {
  const tables = new Map<string, Table>();
  const json = JSON.parse(content);

  // Support format: { "tables": { "tableName": { "columns": { ... } } } }
  // Or: { "tableName": { "columns": { ... } } }
  const tableSource = json.tables || json;

  for (const [tableName, tableDef] of Object.entries(tableSource)) {
    const def = tableDef as Record<string, unknown>;
    const columns = new Map<string, Column>();
    const constraints: Constraint[] = [];

    if (def.columns && typeof def.columns === "object") {
      for (const [colName, colDef] of Object.entries(def.columns as Record<string, unknown>)) {
        const col = colDef as Record<string, unknown>;
        columns.set(colName.toLowerCase(), {
          name: colName.toLowerCase(),
          type: (typeof col.type === "string" ? col.type : "TEXT").toUpperCase(),
          nullable: col.nullable !== false,
          defaultVal: col.default != null ? String(col.default) : null,
          primaryKey: col.primaryKey === true,
          unique: col.unique === true,
        });
      }
    }

    if (Array.isArray(def.constraints)) {
      for (const con of def.constraints) {
        const c = con as Record<string, unknown>;
        constraints.push({
          name: String(c.name || ""),
          type: String(c.type || ""),
          columns: Array.isArray(c.columns) ? (c.columns as string[]) : [],
          references: c.references ? String(c.references) : undefined,
        });
      }
    }

    tables.set(tableName.toLowerCase(), {
      name: tableName.toLowerCase(),
      columns,
      constraints,
    });
  }

  return { tables };
}

// ── Parse file ──
function parseFile(filePath: string): Schema {
  const content = readFileSync(filePath, "utf-8");
  const ext = extname(filePath).toLowerCase();

  if (ext === ".json") {
    return parseJSONSchema(content);
  }
  return parseSQL(content);
}

// ── Diff engine ──
function diffSchemas(oldSchema: Schema, newSchema: Schema): Diff {
  const addedTables: string[] = [];
  const removedTables: string[] = [];
  const changedTables: TableDiff[] = [];

  // Find removed tables
  for (const name of oldSchema.tables.keys()) {
    if (!newSchema.tables.has(name)) {
      removedTables.push(name);
    }
  }

  // Find added tables
  for (const name of newSchema.tables.keys()) {
    if (!oldSchema.tables.has(name)) {
      addedTables.push(name);
    }
  }

  // Find changed tables
  for (const [name, newTable] of newSchema.tables) {
    const oldTable = oldSchema.tables.get(name);
    if (!oldTable) continue;

    const addedColumns: Column[] = [];
    const removedColumns: Column[] = [];
    const changedColumns: ColumnChange[] = [];
    const addedConstraints: Constraint[] = [];
    const removedConstraints: Constraint[] = [];

    // Check columns
    for (const [colName, newCol] of newTable.columns) {
      const oldCol = oldTable.columns.get(colName);
      if (!oldCol) {
        addedColumns.push(newCol);
        continue;
      }

      if (oldCol.type !== newCol.type || oldCol.nullable !== newCol.nullable || oldCol.defaultVal !== newCol.defaultVal) {
        const breaking =
          oldCol.type !== newCol.type ||
          (oldCol.nullable && !newCol.nullable); // Making nullable -> not null is breaking

        changedColumns.push({
          name: colName,
          oldType: oldCol.type,
          newType: newCol.type,
          oldNullable: oldCol.nullable,
          newNullable: newCol.nullable,
          oldDefault: oldCol.defaultVal,
          newDefault: newCol.defaultVal,
          breaking,
        });
      }
    }

    for (const colName of oldTable.columns.keys()) {
      if (!newTable.columns.has(colName)) {
        removedColumns.push(oldTable.columns.get(colName)!);
      }
    }

    // Check constraints
    const oldConstraintKeys = new Set(oldTable.constraints.map((c) => `${c.type}:${c.columns.join(",")}`));
    const newConstraintKeys = new Set(newTable.constraints.map((c) => `${c.type}:${c.columns.join(",")}`));

    for (const con of newTable.constraints) {
      const key = `${con.type}:${con.columns.join(",")}`;
      if (!oldConstraintKeys.has(key)) addedConstraints.push(con);
    }

    for (const con of oldTable.constraints) {
      const key = `${con.type}:${con.columns.join(",")}`;
      if (!newConstraintKeys.has(key)) removedConstraints.push(con);
    }

    if (addedColumns.length || removedColumns.length || changedColumns.length || addedConstraints.length || removedConstraints.length) {
      changedTables.push({
        name,
        addedColumns,
        removedColumns,
        changedColumns,
        addedConstraints,
        removedConstraints,
      });
    }
  }

  return { addedTables, removedTables, changedTables };
}

// ── Output formatters ──
function hasBreakingChanges(diff: Diff): boolean {
  if (diff.removedTables.length > 0) return true;
  for (const t of diff.changedTables) {
    if (t.removedColumns.length > 0) return true;
    if (t.changedColumns.some((c) => c.breaking)) return true;
  }
  return false;
}

function filterBreakingOnly(diff: Diff): Diff {
  return {
    addedTables: [],
    removedTables: diff.removedTables,
    changedTables: diff.changedTables
      .map((t) => ({
        ...t,
        addedColumns: [],
        changedColumns: t.changedColumns.filter((c) => c.breaking),
        addedConstraints: [],
      }))
      .filter((t) => t.removedColumns.length || t.changedColumns.length || t.removedConstraints.length),
  };
}

function formatTerminal(diff: Diff, oldFile: string, newFile: string): string {
  const lines: string[] = [];
  const breaking = hasBreakingChanges(diff);

  lines.push("");
  lines.push(`${c.bold}${c.cyan}  Schema Diff${c.reset}`);
  lines.push(`${c.dim}  ${basename(oldFile)} -> ${basename(newFile)}${c.reset}`);
  lines.push("");

  if (breaking) {
    lines.push(`  ${c.bgRed}${c.white}${c.bold} ⚠ BREAKING CHANGES DETECTED ${c.reset}`);
    lines.push("");
  }

  const total = diff.addedTables.length + diff.removedTables.length + diff.changedTables.length;
  if (total === 0) {
    lines.push(`  ${c.green}✓ Schemas are identical${c.reset}`);
    lines.push("");
    return lines.join("\n");
  }

  // Removed tables
  for (const t of diff.removedTables) {
    lines.push(`  ${c.red}${c.bold}✗ DROPPED TABLE${c.reset} ${c.red}${t}${c.reset}`);
  }

  // Added tables
  for (const t of diff.addedTables) {
    lines.push(`  ${c.green}${c.bold}+ NEW TABLE${c.reset} ${c.green}${t}${c.reset}`);
  }

  if (diff.addedTables.length || diff.removedTables.length) lines.push("");

  // Changed tables
  for (const t of diff.changedTables) {
    lines.push(`  ${c.yellow}${c.bold}~ MODIFIED${c.reset} ${c.yellow}${t.name}${c.reset}`);

    for (const col of t.removedColumns) {
      lines.push(`    ${c.red}- ${col.name}${c.reset} ${c.dim}(${col.type})${c.reset}`);
    }
    for (const col of t.addedColumns) {
      lines.push(`    ${c.green}+ ${col.name}${c.reset} ${c.dim}(${col.type})${c.reset}`);
    }
    for (const ch of t.changedColumns) {
      const marker = ch.breaking ? `${c.red}⚠` : `${c.yellow}~`;
      const parts: string[] = [];
      if (ch.oldType !== ch.newType) parts.push(`type: ${ch.oldType} -> ${ch.newType}`);
      if (ch.oldNullable !== ch.newNullable) parts.push(`nullable: ${ch.oldNullable} -> ${ch.newNullable}`);
      if (ch.oldDefault !== ch.newDefault) parts.push(`default: ${ch.oldDefault ?? "none"} -> ${ch.newDefault ?? "none"}`);
      lines.push(`    ${marker} ${ch.name}${c.reset} ${c.dim}(${parts.join(", ")})${c.reset}`);
    }

    for (const con of t.removedConstraints) {
      lines.push(`    ${c.red}- constraint ${con.type}${c.reset} ${c.dim}(${con.columns.join(", ")})${c.reset}`);
    }
    for (const con of t.addedConstraints) {
      lines.push(`    ${c.green}+ constraint ${con.type}${c.reset} ${c.dim}(${con.columns.join(", ")})${c.reset}`);
    }

    lines.push("");
  }

  // Summary
  const stats: string[] = [];
  if (diff.addedTables.length) stats.push(`${c.green}+${diff.addedTables.length} tables${c.reset}`);
  if (diff.removedTables.length) stats.push(`${c.red}-${diff.removedTables.length} tables${c.reset}`);
  if (diff.changedTables.length) stats.push(`${c.yellow}~${diff.changedTables.length} modified${c.reset}`);
  lines.push(`  ${c.dim}Summary:${c.reset} ${stats.join("  ")}`);
  lines.push("");

  return lines.join("\n");
}

function formatMarkdown(diff: Diff, oldFile: string, newFile: string): string {
  const lines: string[] = [];
  const breaking = hasBreakingChanges(diff);

  lines.push(`# Schema Diff`);
  lines.push("");
  lines.push(`**${basename(oldFile)}** -> **${basename(newFile)}**`);
  lines.push("");

  if (breaking) {
    lines.push(`> **⚠ BREAKING CHANGES DETECTED**`);
    lines.push("");
  }

  const total = diff.addedTables.length + diff.removedTables.length + diff.changedTables.length;
  if (total === 0) {
    lines.push("Schemas are identical. No differences found.");
    return lines.join("\n");
  }

  if (diff.removedTables.length) {
    lines.push("## Dropped Tables");
    for (const t of diff.removedTables) lines.push(`- \`${t}\``);
    lines.push("");
  }

  if (diff.addedTables.length) {
    lines.push("## New Tables");
    for (const t of diff.addedTables) lines.push(`- \`${t}\``);
    lines.push("");
  }

  if (diff.changedTables.length) {
    lines.push("## Modified Tables");
    lines.push("");
    for (const t of diff.changedTables) {
      lines.push(`### \`${t.name}\``);
      lines.push("");

      if (t.removedColumns.length || t.addedColumns.length || t.changedColumns.length) {
        lines.push("| Column | Change | Details |");
        lines.push("|--------|--------|---------|");

        for (const col of t.removedColumns) {
          lines.push(`| \`${col.name}\` | ❌ Removed | was ${col.type} |`);
        }
        for (const col of t.addedColumns) {
          lines.push(`| \`${col.name}\` | ✅ Added | ${col.type} |`);
        }
        for (const ch of t.changedColumns) {
          const parts: string[] = [];
          if (ch.oldType !== ch.newType) parts.push(`type: ${ch.oldType} -> ${ch.newType}`);
          if (ch.oldNullable !== ch.newNullable) parts.push(`nullable: ${ch.oldNullable} -> ${ch.newNullable}`);
          if (ch.oldDefault !== ch.newDefault) parts.push(`default: ${ch.oldDefault ?? "none"} -> ${ch.newDefault ?? "none"}`);
          const icon = ch.breaking ? "⚠️ Breaking" : "🔄 Changed";
          lines.push(`| \`${ch.name}\` | ${icon} | ${parts.join(", ")} |`);
        }
        lines.push("");
      }

      if (t.removedConstraints.length || t.addedConstraints.length) {
        for (const con of t.removedConstraints) {
          lines.push(`- ❌ Removed constraint: ${con.type} (${con.columns.join(", ")})`);
        }
        for (const con of t.addedConstraints) {
          lines.push(`- ✅ Added constraint: ${con.type} (${con.columns.join(", ")})`);
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

function formatJSON(diff: Diff, oldFile: string, newFile: string): object {
  return {
    oldFile: basename(oldFile),
    newFile: basename(newFile),
    breaking: hasBreakingChanges(diff),
    summary: {
      addedTables: diff.addedTables.length,
      removedTables: diff.removedTables.length,
      modifiedTables: diff.changedTables.length,
    },
    addedTables: diff.addedTables,
    removedTables: diff.removedTables,
    changedTables: diff.changedTables.map((t) => ({
      name: t.name,
      addedColumns: t.addedColumns.map((col) => ({ name: col.name, type: col.type })),
      removedColumns: t.removedColumns.map((col) => ({ name: col.name, type: col.type })),
      changedColumns: t.changedColumns,
      addedConstraints: t.addedConstraints,
      removedConstraints: t.removedConstraints,
    })),
  };
}

// ── Help ──
function printHelp(): void {
  console.log(`
${c.bold}${c.cyan}  schema-diff${c.reset} ${c.dim}v${VERSION}${c.reset}
${c.dim}  Compare two database schemas and find differences${c.reset}

${c.bold}  USAGE${c.reset}
    ${c.green}$ schema-diff <old-schema> <new-schema>${c.reset}
    ${c.green}$ schema-diff old.sql new.sql --format markdown${c.reset}
    ${c.green}$ schema-diff v1.json v2.json --breaking-only --json${c.reset}

${c.bold}  ARGUMENTS${c.reset}
    ${c.yellow}<old-schema>${c.reset}    Path to the old/original schema file (.sql or .json)
    ${c.yellow}<new-schema>${c.reset}    Path to the new/updated schema file (.sql or .json)

${c.bold}  OPTIONS${c.reset}
    ${c.yellow}--format${c.reset}          Output format: terminal (default), markdown
    ${c.yellow}--breaking-only${c.reset}   Show only breaking/dangerous changes
    ${c.yellow}--json${c.reset}            Output results as JSON
    ${c.yellow}--help${c.reset}            Show this help message
    ${c.yellow}--version${c.reset}         Show version number

${c.bold}  SUPPORTED FORMATS${c.reset}
    ${c.blue}.sql${c.reset}   SQL CREATE TABLE statements (Postgres, MySQL, SQLite)
    ${c.blue}.json${c.reset}  JSON schema definitions

${c.bold}  EXAMPLES${c.reset}
    ${c.dim}# Compare two SQL files${c.reset}
    ${c.green}$ schema-diff db-v1.sql db-v2.sql${c.reset}

    ${c.dim}# Show only breaking changes in markdown${c.reset}
    ${c.green}$ schema-diff old.sql new.sql --breaking-only --format markdown${c.reset}

    ${c.dim}# Pipe JSON output to another tool${c.reset}
    ${c.green}$ schema-diff old.json new.json --json | jq .breaking${c.reset}
`);
}

// ── Main ──
function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  const flags = {
    json: args.includes("--json"),
    breakingOnly: args.includes("--breaking-only"),
    format: "terminal" as string,
  };

  const formatIdx = args.indexOf("--format");
  if (formatIdx !== -1 && args[formatIdx + 1]) {
    flags.format = args[formatIdx + 1];
  }

  const positional = args.filter((a) => !a.startsWith("--"));

  if (positional.length < 2) {
    if (!flags.json) {
      console.error(`\n  ${c.red}${c.bold}Error:${c.reset} Two schema files are required.\n`);
      console.error(`  ${c.dim}Usage: schema-diff <old-schema> <new-schema>${c.reset}\n`);
      console.error(`  ${c.dim}Run schema-diff --help for more info${c.reset}\n`);
    } else {
      console.log(JSON.stringify({ error: "Two schema files are required" }, null, 2));
    }
    process.exit(1);
  }

  const [oldFile, newFile] = positional;

  try {
    const oldSchema = parseFile(oldFile);
    const newSchema = parseFile(newFile);
    let diff = diffSchemas(oldSchema, newSchema);

    if (flags.breakingOnly) {
      diff = filterBreakingOnly(diff);
    }

    if (flags.json) {
      console.log(JSON.stringify(formatJSON(diff, oldFile, newFile), null, 2));
    } else if (flags.format === "markdown") {
      console.log(formatMarkdown(diff, oldFile, newFile));
    } else {
      console.log(formatTerminal(diff, oldFile, newFile));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (flags.json) {
      console.log(JSON.stringify({ error: msg }, null, 2));
    } else {
      console.error(`\n  ${c.red}${c.bold}Error:${c.reset} ${msg}\n`);
    }
    process.exit(1);
  }
}

main();
