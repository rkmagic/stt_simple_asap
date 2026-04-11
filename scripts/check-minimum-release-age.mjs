/**
 * Ensures every tarball dependency in package-lock.json was published at least
 * MIN_RELEASE_AGE_DAYS ago (supply-chain: avoid brand-new compromised releases).
 *
 * Env:
 *   MIN_RELEASE_AGE_DAYS  (default: 3)
 *   SKIP_MIN_RELEASE_AGE  set to "1" or "true" to skip (emergency only)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lockPath = path.join(__dirname, "..", "package-lock.json");

function packageNameFromLockKey(key) {
  const parts = key.split(/[/\\]/);
  const indices = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] === "node_modules") {
      indices.push(i);
    }
  }
  if (indices.length === 0) {
    return null;
  }
  const last = indices[indices.length - 1];
  const nameParts = parts.slice(last + 1);
  if (nameParts.length === 0) {
    return null;
  }
  if (nameParts[0].startsWith("@")) {
    return nameParts.length >= 2 ? `${nameParts[0]}/${nameParts[1]}` : null;
  }
  return nameParts[0];
}

function collectPackages(lock) {
  const packages = lock.packages || {};
  /** @type {Map<string, Set<string>>} */
  const byName = new Map();

  for (const key of Object.keys(packages)) {
    if (key === "") {
      continue;
    }
    const entry = packages[key];
    if (!entry || !entry.version || !entry.resolved) {
      continue;
    }
    if (!String(entry.resolved).startsWith("http")) {
      continue;
    }

    const pkgName = packageNameFromLockKey(key);
    if (!pkgName) {
      continue;
    }

    if (!byName.has(pkgName)) {
      byName.set(pkgName, new Set());
    }
    byName.get(pkgName).add(entry.version);
  }

  return byName;
}

async function main() {
  if (
    process.env.SKIP_MIN_RELEASE_AGE === "1" ||
    process.env.SKIP_MIN_RELEASE_AGE === "true"
  ) {
    console.log(
      "check-minimum-release-age: skipped (SKIP_MIN_RELEASE_AGE is set)"
    );
    return;
  }

  const minDays = Math.max(
    0,
    parseInt(process.env.MIN_RELEASE_AGE_DAYS || "3", 10)
  );
  const minMs = minDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
    console.error("check-minimum-release-age: unsupported lockfileVersion");
    process.exit(1);
  }

  const byName = collectPackages(lock);
  const failures = [];

  for (const [name, versions] of byName) {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
    let data;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        failures.push({
          name,
          detail: `registry HTTP ${res.status}`,
        });
        continue;
      }
      data = await res.json();
    } catch (e) {
      failures.push({
        name,
        detail: e.message || String(e),
      });
      continue;
    }

    const timeMap = data.time || {};
    for (const version of versions) {
      const publishedAt = timeMap[version];
      if (!publishedAt) {
        failures.push({
          name,
          version,
          detail: "no publish time for this version in registry metadata",
        });
        continue;
      }
      const published = new Date(publishedAt).getTime();
      const age = now - published;
      if (age < minMs) {
        failures.push({
          name,
          version,
          detail: `published ${publishedAt} (newer than ${minDays} day(s))`,
        });
      }
    }
  }

  if (failures.length > 0) {
    console.error(
      `Minimum release age check failed (require >= ${minDays} day(s) on npm):`
    );
    for (const f of failures) {
      const ver = f.version != null ? `@${f.version}` : "";
      console.error(`  ${f.name}${ver}: ${f.detail}`);
    }
    console.error(
      "\nTo bypass temporarily (not recommended): SKIP_MIN_RELEASE_AGE=1"
    );
    process.exit(1);
  }

  console.log(
    `check-minimum-release-age: OK (all locked packages >= ${minDays} day(s) on npm)`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
