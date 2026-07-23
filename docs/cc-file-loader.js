(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CcFileLoader = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  const TAZ_FIELDS = ["TAZ_ID", "TAZID", "TAZ", "ZONE_ID", "ZONEID", "ZONE", "N"];
  const NODE_FIELDS = ["CC_NODE", "NODE_ID", "NODEID", "NODE", "B_NODE", "TONODE", "TO_NODE"];
  const CC_PT_FIELDS = ["CC_PT", "CCPT", "CONNECTOR_ID", "CONNECTORID"];

  function cleanId(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    return /^[-+]?\d+\.0+$/.test(text) ? text.replace(/\.0+$/, "") : text;
  }

  function normalizedProperties(row) {
    const result = {};
    for (const [key, value] of Object.entries(row || {})) {
      result[String(key).trim().toUpperCase()] = value;
    }
    return result;
  }

  function firstValue(row, names) {
    for (const name of names) {
      if (row[name] !== undefined && String(row[name]).trim() !== "") return row[name];
    }
    return "";
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else if (char === '"') {
          quoted = false;
        } else {
          field += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field.replace(/\r$/, ""));
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += char;
      }
    }
    if (field || row.length) {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
    }
    const headers = (rows.shift() || []).map((value) => value.trim().replace(/^\ufeff/, ""));
    return rows
      .filter((values) => values.some((value) => String(value).trim()))
      .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  }

  function parseDbf(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength < 33) throw new Error("DBF header is incomplete.");
    const recordCount = view.getUint32(4, true);
    const headerLength = view.getUint16(8, true);
    const recordLength = view.getUint16(10, true);
    if (headerLength < 33 || recordLength < 1 || headerLength > view.byteLength) {
      throw new Error("DBF header is invalid.");
    }
    const bytes = new Uint8Array(buffer);
    const ascii = new TextDecoder("windows-1252");
    const fields = [];
    for (let offset = 32; offset + 32 <= headerLength && bytes[offset] !== 0x0d; offset += 32) {
      let end = offset;
      while (end < offset + 11 && bytes[end] !== 0) end += 1;
      const name = ascii.decode(bytes.slice(offset, end)).trim();
      const type = String.fromCharCode(bytes[offset + 11]);
      const length = bytes[offset + 16];
      if (name && length) fields.push({ name, type, length });
    }
    const rows = [];
    for (let index = 0; index < recordCount; index += 1) {
      const start = headerLength + index * recordLength;
      if (start + recordLength > bytes.length) break;
      if (bytes[start] === 0x2a) continue;
      const row = {};
      let offset = start + 1;
      for (const fieldInfo of fields) {
        const raw = ascii.decode(bytes.slice(offset, offset + fieldInfo.length)).replace(/\0/g, "").trim();
        row[fieldInfo.name] = raw;
        offset += fieldInfo.length;
      }
      rows.push(row);
    }
    return rows;
  }

  function parseShp(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength < 100 || view.getInt32(0, false) !== 9994) throw new Error("SHP header is invalid.");
    const geometries = [];
    let offset = 100;
    while (offset + 8 <= view.byteLength) {
      const contentBytes = view.getInt32(offset + 4, false) * 2;
      const start = offset + 8;
      if (contentBytes < 4 || start + contentBytes > view.byteLength) break;
      const shapeType = view.getInt32(start, true);
      let geometry = null;
      if ([1, 11, 21].includes(shapeType) && contentBytes >= 20) {
        geometry = { type: "Point", coordinates: [view.getFloat64(start + 4, true), view.getFloat64(start + 12, true)] };
      } else if ([3, 5, 13, 15, 23, 25].includes(shapeType) && contentBytes >= 44) {
        const partCount = view.getInt32(start + 36, true);
        const pointCount = view.getInt32(start + 40, true);
        const partsOffset = start + 44;
        const pointsOffset = partsOffset + partCount * 4;
        if (partCount >= 1 && pointCount >= 1 && pointsOffset + pointCount * 16 <= start + contentBytes) {
          const starts = [];
          for (let part = 0; part < partCount; part += 1) starts.push(view.getInt32(partsOffset + part * 4, true));
          starts.push(pointCount);
          const lines = [];
          for (let part = 0; part < partCount; part += 1) {
            const coords = [];
            for (let point = starts[part]; point < starts[part + 1]; point += 1) {
              coords.push([
                view.getFloat64(pointsOffset + point * 16, true),
                view.getFloat64(pointsOffset + point * 16 + 8, true),
              ]);
            }
            if (coords.length) lines.push(coords);
          }
          geometry = lines.length === 1
            ? { type: shapeType === 5 || shapeType === 15 || shapeType === 25 ? "Polygon" : "LineString", coordinates: shapeType === 5 || shapeType === 15 || shapeType === 25 ? lines : lines[0] }
            : { type: shapeType === 5 || shapeType === 15 || shapeType === 25 ? "Polygon" : "MultiLineString", coordinates: lines };
        }
      }
      geometries.push(geometry);
      offset = start + contentBytes;
    }
    return geometries;
  }

  function rowsFromJson(value) {
    if (Array.isArray(value)) return value;
    if (value && value.type === "FeatureCollection") {
      return (value.features || []).map((feature) => ({ ...(feature.properties || {}), __geometry: feature.geometry || null }));
    }
    if (value && Array.isArray(value.connectors)) return value.connectors;
    throw new Error("JSON must be a FeatureCollection, an array, or contain a connectors array.");
  }

  function normalizeRows(rows, knownTazIds) {
    const known = new Set(Array.from(knownTazIds || [], cleanId));
    const byTaz = {};
    const seen = new Set();
    let ignored = 0;
    let duplicates = 0;
    for (const sourceRow of rows) {
      const row = normalizedProperties(sourceRow);
      let tazId = cleanId(firstValue(row, TAZ_FIELDS));
      let nodeId = cleanId(firstValue(row, NODE_FIELDS));
      const ccPt = cleanId(firstValue(row, CC_PT_FIELDS));
      if (!tazId && ccPt) {
        const prefix = cleanId(ccPt.split("_")[0]);
        if (known.has(prefix)) tazId = prefix;
      }
      if (!tazId || !nodeId) {
        const a = cleanId(row.A);
        const b = cleanId(row.B);
        if (known.has(a) && b) {
          tazId = a;
          nodeId = b;
        } else if (known.has(b) && a) {
          tazId = b;
          nodeId = a;
        }
      }
      if (!known.has(tazId) || !nodeId || tazId === nodeId) {
        ignored += 1;
        continue;
      }
      const key = `${tazId}\u0000${nodeId}`;
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      byTaz[tazId] ||= [];
      byTaz[tazId].push({
        tazId,
        nodeId,
        ccPt,
        geometry: sourceRow.__geometry || row.__GEOMETRY || null,
        properties: sourceRow,
      });
    }
    return { byTaz, connectorCount: seen.size, ignored, duplicates, inputRows: rows.length };
  }

  function missingLinkPairKey(firstId, secondId) {
    const ids = [cleanId(firstId), cleanId(secondId)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return `${ids[0]}|${ids[1]}`;
  }

  function normalizeMissingLinkRows(rows) {
    const links = [];
    const seen = new Set();
    let ignored = 0;
    let duplicates = 0;
    for (const sourceRow of rows || []) {
      const row = normalizedProperties(sourceRow);
      const a = cleanId(row.A);
      const b = cleanId(row.B);
      const isHereMissing = cleanId(row.HERE_MISS) === "1" || cleanId(row.FCLASS) === "7";
      if (!a || !b || a === b || !isHereMissing) {
        ignored += 1;
        continue;
      }
      const pairKey = missingLinkPairKey(a, b);
      if (seen.has(pairKey)) {
        duplicates += 1;
        continue;
      }
      seen.add(pairKey);
      links.push({ pairKey, a, b });
    }
    return { links, linkCount: links.length, ignored, duplicates, inputRows: (rows || []).length };
  }

  async function loadFiles(fileList, knownTazIds) {
    const files = Array.from(fileList || []);
    if (!files.length) throw new Error("Choose a DBF, CSV, SHP + DBF, GeoJSON, or JSON file.");
    const byKey = new Map(files.map((file) => [file.name.replace(/\.[^.]+$/, "").toLowerCase(), file]));
    const rows = [];
    const processed = new Set();
    for (const file of files) {
      const extension = (file.name.split(".").pop() || "").toLowerCase();
      const key = file.name.replace(/\.[^.]+$/, "").toLowerCase();
      if (processed.has(file)) continue;
      if (extension === "dbf") {
        const dbfRows = parseDbf(await file.arrayBuffer());
        const shp = files.find((candidate) => candidate.name.replace(/\.[^.]+$/, "").toLowerCase() === key && /\.shp$/i.test(candidate.name));
        if (shp) {
          const geometries = parseShp(await shp.arrayBuffer());
          dbfRows.forEach((row, index) => { row.__geometry = geometries[index] || null; });
          processed.add(shp);
        }
        rows.push(...dbfRows);
      } else if (extension === "csv" || extension === "cvs") {
        rows.push(...parseCsv(await file.text()));
      } else if (extension === "json" || extension === "geojson") {
        rows.push(...rowsFromJson(JSON.parse(await file.text())));
      } else if (extension === "shp") {
        const companion = files.find((candidate) => candidate.name.replace(/\.[^.]+$/, "").toLowerCase() === key && /\.dbf$/i.test(candidate.name));
        if (!companion) throw new Error(`Select ${file.name} together with its same-name DBF file.`);
      } else {
        throw new Error(`Unsupported file type: ${file.name}`);
      }
      processed.add(file);
    }
    const result = normalizeRows(rows, knownTazIds);
    result.sourceNames = files.map((file) => file.name);
    if (!result.connectorCount) {
      throw new Error("No valid TAZ-to-node CC records were found. Expected A/B or TAZ_ID/CC_NODE fields.");
    }
    return result;
  }

  async function loadMissingLinkFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) throw new Error("Choose a HERE_MISS DBF or CSV file.");
    const rows = [];
    for (const file of files) {
      const extension = (file.name.split(".").pop() || "").toLowerCase();
      if (extension === "dbf") rows.push(...parseDbf(await file.arrayBuffer()));
      else if (extension === "csv" || extension === "cvs") rows.push(...parseCsv(await file.text()));
      else throw new Error(`Unsupported HERE_MISS file type: ${file.name}`);
    }
    const result = normalizeMissingLinkRows(rows);
    result.sourceNames = files.map((file) => file.name);
    if (!result.linkCount) {
      throw new Error("No valid HERE_MISS records were found. Expected A/B fields with HERE_MISS=1 or FCLASS=7.");
    }
    return result;
  }

  return {
    cleanId,
    loadFiles,
    loadMissingLinkFiles,
    normalizeRows,
    normalizeMissingLinkRows,
    parseCsv,
    parseDbf,
    parseShp,
    rowsFromJson,
  };
});
