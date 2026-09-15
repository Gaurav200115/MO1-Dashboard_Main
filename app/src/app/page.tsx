import { readFile } from "node:fs/promises";
import path from "node:path";
import Desk from "@/components/Desk";
import { loadFloatTable } from "@/lib/float";
import type { DeskIndex } from "@/lib/types";

/**
 * The index is read on the server so the table paints without a client round
 * trip. Per-company statements stay lazy — see CompanySheet.
 */
async function loadIndex(): Promise<DeskIndex> {
  const file = path.join(process.cwd(), "public", "data", "index.json");
  return JSON.parse(await readFile(file, "utf8")) as DeskIndex;
}

export default async function Page() {
  const data = await loadIndex();

  // Share counts and promoter stakes for the sector index weights. This page is
  // statically prerendered, so all 200 company files are parsed once at build.
  const floats = await loadFloatTable(data.companies.map((c) => c.symbol));

  return <Desk data={data} floats={floats} />;
}
