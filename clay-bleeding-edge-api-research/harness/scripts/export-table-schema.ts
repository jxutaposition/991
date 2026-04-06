/**
 * Table Schema Export Script
 *
 * Exports a Clay table's full schema via the v3 API and converts it
 * to ClayMate-compatible portable JSON format. This validates the
 * export pipeline that will become the clay_export_schema tool.
 *
 * Usage:
 *   npx tsx export-table-schema.ts --table-id t_xxx [--view-id gv_xxx]
 *
 * Prerequisites:
 *   - Session cookies file at ../results/.session-cookies.json
 *     (generate with extract-session.ts)
 *
 * Output:
 *   - ../results/schema-{tableId}-{date}.json (portable ClayMate format)
 *   - ../results/schema-{tableId}-{date}.raw.json (raw v3 API response)
 */

import * as fs from "fs";
import * as path from "path";

const API_BASE = "https://api.clay.com/v3";
const RESULTS_DIR = path.join(__dirname, "..", "results");
const COOKIE_FILE = path.join(RESULTS_DIR, ".session-cookies.json");

interface Field {
  id: string;
  name: string;
  type: string;
  typeSettings: any;
  sourceDetails?: any[];
}

interface PortableColumn {
  index: number;
  name: string;
  type: string;
  typeSettings?: any;
  sourceDetails?: any[];
}

interface PortableSchema {
  version: string;
  exportedAt: string;
  columnCount: number;
  columns: PortableColumn[];
}

function loadCookies(): string {
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error(
      `No session cookies found at ${COOKIE_FILE}. Run extract-session.ts first.`
    );
  }
  const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
  return cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
}

async function clayApi(
  endpoint: string,
  cookieHeader: string
): Promise<any> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      Cookie: cookieHeader,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Clay-Frontend-Version": "unknown",
    },
  });

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ message: response.statusText }));
    throw new Error(`API error ${response.status}: ${JSON.stringify(error)}`);
  }

  return response.json();
}

function transformFieldReferences(
  obj: any,
  fieldIdToName: Record<string, string>,
  sourceDataRefToName: Record<string, string>
): any {
  if (typeof obj === "string") {
    return obj.replace(/\{\{(f_[a-zA-Z0-9_]+)\}\}/g, (_match, fieldId) => {
      const fieldName = fieldIdToName[fieldId];
      if (fieldName) return `{{@${fieldName}}}`;
      const sourceName = sourceDataRefToName[fieldId];
      if (sourceName) return `{{@source:${sourceName}}}`;
      return _match;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map((item) =>
      transformFieldReferences(item, fieldIdToName, sourceDataRefToName)
    );
  }

  if (obj && typeof obj === "object") {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = transformFieldReferences(
        value,
        fieldIdToName,
        sourceDataRefToName
      );
    }
    return result;
  }

  return obj;
}

async function exportSchema(
  tableId: string,
  viewId: string | null,
  cookieHeader: string
): Promise<{ raw: any; portable: PortableSchema }> {
  console.log(`[export] Fetching table ${tableId}...`);
  const tableData = await clayApi(`/tables/${tableId}`, cookieHeader);

  const fields: Field[] =
    tableData.fields || tableData.table?.fields || [];
  const gridViews = tableData.gridViews || tableData.table?.gridViews || [];

  if (fields.length === 0) {
    throw new Error("No fields found in table response");
  }

  console.log(`[export] Found ${fields.length} fields`);

  // Determine field order
  const view = viewId
    ? gridViews.find((v: any) => v.id === viewId)
    : gridViews[0];
  const viewFieldOrder: string[] = view?.fieldOrder || [];
  const orderedFieldIds =
    viewFieldOrder.length > 0
      ? viewFieldOrder
      : fields.map((f) => f.id);

  // Build mappings
  const fieldIdToName: Record<string, string> = {};
  fields.forEach((f) => {
    fieldIdToName[f.id] = f.name;
  });

  const sourceDataRefToName: Record<string, string> = {};

  // Fetch source details for source columns
  const orderedFields: Field[] = [];
  for (const fieldId of orderedFieldIds) {
    if (fieldId === "f_created_at" || fieldId === "f_updated_at") continue;
    const field = fields.find((f) => f.id === fieldId);
    if (!field) continue;

    if (field.type === "source" && field.typeSettings?.sourceIds) {
      try {
        const sourceDetails = await Promise.all(
          field.typeSettings.sourceIds.map((sid: string) =>
            clayApi(`/sources/${sid}`, cookieHeader)
          )
        );
        field.sourceDetails = sourceDetails;
        sourceDetails.forEach((source: any) => {
          if (source.dataFieldId) {
            sourceDataRefToName[source.dataFieldId] = field.name;
          }
        });
      } catch (err) {
        console.warn(
          `[export] Failed to fetch source details for "${field.name}": ${err}`
        );
      }
    }

    orderedFields.push(field);
  }

  // Transform to portable format
  const portableColumns: PortableColumn[] = orderedFields.map(
    (field, index) => {
      const portable: PortableColumn = {
        index,
        name: field.name,
        type: field.type,
      };

      if (field.typeSettings) {
        portable.typeSettings = transformFieldReferences(
          JSON.parse(JSON.stringify(field.typeSettings)),
          fieldIdToName,
          sourceDataRefToName
        );
      }

      if (field.type === "source" && field.sourceDetails) {
        portable.sourceDetails = field.sourceDetails.map((source: any) => ({
          name: source.name,
          type: source.type,
          dataFieldId: source.dataFieldId,
          typeSettings: transformFieldReferences(
            JSON.parse(JSON.stringify(source.typeSettings)),
            fieldIdToName,
            sourceDataRefToName
          ),
        }));
      }

      return portable;
    }
  );

  const portable: PortableSchema = {
    version: "1.0",
    exportedAt: new Date().toISOString(),
    columnCount: portableColumns.length,
    columns: portableColumns,
  };

  return { raw: tableData, portable };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let tableId = "";
  let viewId: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--table-id") tableId = args[++i];
    if (args[i] === "--view-id") viewId = args[++i];
  }

  if (!tableId) {
    console.error("Usage: npx tsx export-table-schema.ts --table-id t_xxx [--view-id gv_xxx]");
    process.exit(1);
  }

  const cookieHeader = loadCookies();
  const { raw, portable } = await exportSchema(tableId, viewId, cookieHeader);

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const date = new Date().toISOString().split("T")[0];

  const rawFile = path.join(RESULTS_DIR, `schema-${tableId}-${date}.raw.json`);
  fs.writeFileSync(rawFile, JSON.stringify(raw, null, 2));
  console.log(`[export] Raw API response saved to ${rawFile}`);

  const portableFile = path.join(
    RESULTS_DIR,
    `schema-${tableId}-${date}.json`
  );
  fs.writeFileSync(portableFile, JSON.stringify(portable, null, 2));
  console.log(`[export] Portable schema saved to ${portableFile}`);

  console.log(`\n[export] Schema summary:`);
  console.log(`  Columns: ${portable.columnCount}`);
  portable.columns.forEach((col) => {
    const formula =
      col.type === "formula"
        ? ` → ${col.typeSettings?.formulaText?.substring(0, 60) || "?"}`
        : "";
    console.log(`  ${col.index}. ${col.name} (${col.type})${formula}`);
  });

  // Verify no internal references remain
  const portableStr = JSON.stringify(portable);
  const internalRefs = portableStr.match(/\{\{f_[a-zA-Z0-9_]+\}\}/g);
  if (internalRefs) {
    console.warn(
      `\n[export] WARNING: ${internalRefs.length} internal references not resolved:`
    );
    internalRefs.forEach((ref) => console.warn(`  ${ref}`));
  } else {
    console.log("\n[export] All field references converted to portable format.");
  }
}

main().catch((err) => {
  console.error("[export] Fatal error:", err);
  process.exit(1);
});
