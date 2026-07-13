import { describe, expect, it } from "vitest";
import {
  exportCsvContent,
  emptyRow,
  parseImportedCsv,
  validateRows,
  COLUMNS,
  type ParsedRow,
} from "./csv";

const CLASSES = ["open", "floater"];
const SINGLE_CLASS = ["open"];

function makeRow(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return { ...emptyRow([]), name: "Jane Doe", pilot_class: "open", ...overrides };
}

describe("COLUMNS order", () => {
  it("puts the sporting-body IDs after the everyday columns", () => {
    expect(COLUMNS.map((c) => c.header)).toEqual([
      "name",
      "email",
      "glider",
      "class",
      "team",
      "driver",
      "civl_id",
      "safa_id",
      "ushpa_id",
      "bhpa_id",
      "dhv_id",
      "ffvl_id",
      "fai_id",
    ]);
  });
});

describe("exportCsvContent", () => {
  it("writes the header row alone for an empty table (fillable template)", () => {
    expect(exportCsvContent([])).toBe(
      "name,email,glider,class,team,driver,civl_id,safa_id,ushpa_id,bhpa_id,dhv_id,ffvl_id,fai_id\n"
    );
  });

  it("round-trips through parseImportedCsv", () => {
    const rows = [
      makeRow({ email: "jane@example.com", civl_id: "12345", team_name: "Team A" }),
      makeRow({ name: 'Bob "Ace" Smith', pilot_class: "floater", driver_contact: "+61 400 000 000" }),
    ];
    const parsed = parseImportedCsv(exportCsvContent(rows), CLASSES);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual(rows);
  });
});

describe("parseImportedCsv robustness", () => {
  it("is independent of column order", () => {
    const { rows, errors } = parseImportedCsv(
      "civl_id,class,name,email\n12345,open,Jane Doe,jane@example.com\n",
      CLASSES
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      makeRow({ email: "jane@example.com", civl_id: "12345" }),
    ]);
  });

  it("is case-insensitive on headers", () => {
    const { rows, errors } = parseImportedCsv(
      "Name,Email,CIVL_ID,Class\nJane Doe,jane@example.com,12345,open\n",
      CLASSES
    );
    expect(errors).toEqual([]);
    expect(rows[0].civl_id).toBe("12345");
  });

  it("accepts a name-and-class-only file — every ID column is optional", () => {
    const { rows, errors } = parseImportedCsv("name,class\nJane Doe,open\n", CLASSES);
    expect(errors).toEqual([]);
    expect(rows).toEqual([makeRow()]);
  });

  it("defaults a missing class column when the comp has a single class", () => {
    const { rows, errors } = parseImportedCsv("name\nJane Doe\nBob Smith\n", SINGLE_CLASS);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.pilot_class)).toEqual(["open", "open"]);
  });

  it("defaults a blank class cell when the comp has a single class", () => {
    const { rows, errors } = parseImportedCsv("name,class\nJane Doe,\n", SINGLE_CLASS);
    expect(errors).toEqual([]);
    expect(rows[0].pilot_class).toBe("open");
  });

  it("keeps rows but flags them when class is missing in a multi-class comp", () => {
    const { rows, errors } = parseImportedCsv("name\nJane Doe\n", CLASSES);
    expect(rows).toHaveLength(1);
    expect(rows[0].pilot_class).toBe("");
    expect(errors).toEqual([
      "Row 1 (Jane Doe): class is missing — set it before saving",
    ]);
  });

  it("requires only the name column", () => {
    const { rows, errors } = parseImportedCsv("email,class\njane@example.com,open\n", CLASSES);
    expect(rows).toEqual([]);
    expect(errors).toEqual(['CSV must contain a "name" column (all other columns are optional)']);
  });

  it("ignores unknown columns", () => {
    const { rows, errors } = parseImportedCsv(
      "name,class,nationality\nJane Doe,open,AUS\n",
      CLASSES
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([makeRow()]);
  });

  it("strips a UTF-8 BOM (Excel exports)", () => {
    const { rows, errors } = parseImportedCsv("\uFEFFname,class\nJane Doe,open\n", CLASSES);
    expect(errors).toEqual([]);
    expect(rows).toEqual([makeRow()]);
  });

  it("auto-detects tab separators", () => {
    const { rows, errors } = parseImportedCsv("name\tclass\nJane Doe\topen\n", CLASSES);
    expect(errors).toEqual([]);
    expect(rows).toEqual([makeRow()]);
  });

  it("auto-detects semicolon separators (European Excel locales)", () => {
    const { rows, errors } = parseImportedCsv(
      "name;email;class\nJane Doe;jane@example.com;open\n",
      CLASSES
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([makeRow({ email: "jane@example.com" })]);
  });

  it("accepts header aliases (civl, pilot_name, team_name)", () => {
    const { rows, errors } = parseImportedCsv(
      "pilot_name,civl,team_name,class\nJane Doe,12345,Team A,open\n",
      CLASSES
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([makeRow({ civl_id: "12345", team_name: "Team A" })]);
  });

  it("flags an invalid class but keeps the row for fixing in the grid", () => {
    const { rows, errors } = parseImportedCsv("name,class\nJane Doe,sport\n", CLASSES);
    expect(rows).toHaveLength(1);
    expect(errors[0]).toContain('class "sport" is not valid');
  });
});

describe("validateRows", () => {
  it("treats every sporting-body ID as optional", () => {
    const { payload, errors } = validateRows([makeRow()], CLASSES);
    expect(errors).toEqual([]);
    expect(payload).toHaveLength(1);
    expect(payload[0].registered_pilot_civl_id).toBeNull();
  });

  it("still requires name and class", () => {
    const { errors } = validateRows(
      [makeRow({ name: "" }), makeRow({ name: "Bob", pilot_class: "" })],
      CLASSES
    );
    expect(errors).toEqual([
      "Row 1: name is required",
      "Row 2 (Bob): class is required",
    ]);
  });
});
