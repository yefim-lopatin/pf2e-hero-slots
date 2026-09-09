import { readFile, access, mkdir, mkdtemp, cp, rm, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "module.json"), "utf8"));
if (manifest.id !== "pf2e-hero-slots" || manifest.compatibility.verified !== "14.367" || !manifest.socket ||
    manifest.relationships.systems[0].id !== "pf2e") throw new Error("Некорректный манифест");
for (const file of [...manifest.esmodules, ...manifest.styles, "templates/slots.hbs", "README.md"]) await access(join(root, file));
for (const file of (await readdir(join(root, "scripts"))).filter(f => f.endsWith(".js"))) {
  execFileSync(process.execPath, ["--check", join(root, "scripts", file)]);
}
const temp = await mkdtemp(join(tmpdir(), "hero-slots-build-"));
const output = resolve(root, "dist", `${manifest.id}.zip`);
try {
  const target = join(temp, manifest.id);
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(target, "scripts"), { recursive: true });
  for (const file of ["module.json", "README.md", "styles", "templates"]) await cp(join(root, file), join(target, file), { recursive: true });
  for (const file of ["module.js", "rules.js", "session.js", "app.js"]) await cp(join(root, "scripts", file), join(target, "scripts", file));
  await rm(output, { force: true });
  execFileSync("zip", ["-qr", output, manifest.id], { cwd: temp });
  execFileSync("unzip", ["-t", output]);
  const archivedManifest = JSON.parse(execFileSync("unzip", ["-p", output, `${manifest.id}/module.json`], { encoding: "utf8" }));
  if (archivedManifest.version !== manifest.version) throw new Error("Версия архива не совпала");
  console.log(`Архив проверен: dist/${manifest.id}.zip; версия ${manifest.version}`);
} finally { await rm(temp, { recursive: true, force: true }); }
