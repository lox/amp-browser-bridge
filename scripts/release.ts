// Builds dist/amp-browser-bridge-<version>.zip from extension/, ready to load
// unpacked or upload to the Chrome Web Store.
//
//   bun run release            # keeps the manifest key, so the ID stays fixed
//   bun run release --no-key   # drops it, for Chrome Web Store uploads (the store keeps its own key)
//
// The zip is written here rather than with `zip` so the build needs no extra
// tools and the same sources always give the same bytes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const root = join(import.meta.dir, "..");
const src = join(root, "extension");
const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));

// The Chrome Web Store refuses a package whose description is longer than this.
if ([...manifest.description].length > 132) throw new Error(`manifest description is ${[...manifest.description].length} characters; the store allows 132`);
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) throw new Error(`manifest version ${manifest.version} is not one Chrome accepts`);
const referenced = [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons)];
for (const file of referenced as string[]) if (!existsSync(join(src, file))) throw new Error(`manifest names ${file}, which is missing`);

if (process.argv.includes("--no-key")) delete manifest.key;

const files = new Map<string, Buffer>();
(function walk(dir: string) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.set(relative(src, path).split("\\").join("/"), readFileSync(path));
  }
})(src);
files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));

// A plain zip: one deflated entry per file, all dated 1980-01-01 so rebuilds match.
const locals: Buffer[] = [];
const centrals: Buffer[] = [];
let offset = 0;
for (const [name, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
  const nameBytes = Buffer.from(name);
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(0, 10); // time
  local.writeUInt16LE(0x21, 12); // date 1980-01-01
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  locals.push(local, nameBytes, packed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4); // made by Unix, zip 2.0
  local.copy(central, 6, 4, 30); // version needed through name length
  central.writeUInt32LE(0o100644 * 0x10000, 38); // rw-r--r--
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBytes);
  offset += local.length + nameBytes.length + packed.length;
}
const directory = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.size, 8);
end.writeUInt16LE(files.size, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...locals, directory, end]);

const out = join(root, "dist", `amp-browser-bridge-${manifest.version}${manifest.key ? "" : "-no-key"}.zip`);
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(out, zip);
const sha = createHash("sha256").update(zip).digest("hex");
console.log(`${relative(root, out)}  ${files.size} files, ${zip.length} bytes, sha256 ${sha}`);
