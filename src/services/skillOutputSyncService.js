import fs from "fs/promises";
import path from "path";
import { config } from "../config.js";

const CANONICAL_FILE_NAME = "jobs.json";

async function listDatedDirectories(rootDir) {
  let entries;

  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(
        `Skill output directory not found: ${rootDir}. Set SKILL_OUTPUT_ROOT to a valid mounted or bundled path.`
      );
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

async function firstExistingJson(dateDir) {
  const canonicalPath = path.join(dateDir, CANONICAL_FILE_NAME);
  try {
    await fs.access(canonicalPath);
    return canonicalPath;
  } catch {
    return null;
  }
}

export async function resolveLatestSkillOutputDir(rootDir = config.skillOutputRoot) {
  const datedDirs = await listDatedDirectories(rootDir);
  if (datedDirs.length === 0) {
    throw new Error(`No dated skill output directories found under ${rootDir}`);
  }

  for (const dirName of datedDirs) {
    const dirPath = path.join(rootDir, dirName);
    if (await firstExistingJson(dirPath)) {
      return dirPath;
    }
  }

  throw new Error(
    `No canonical ${CANONICAL_FILE_NAME} was found in any dated skill output directory under ${rootDir}`
  );
}

export async function resolveLatestSkillJson(rootDir = config.skillOutputRoot) {
  const latestDirPath = await resolveLatestSkillOutputDir(rootDir);
  const candidate = await firstExistingJson(latestDirPath);
  if (!candidate) {
    throw new Error(
      `Missing canonical ${CANONICAL_FILE_NAME} in latest output directory: ${latestDirPath}`
    );
  }

  return candidate;
}

export async function loadJobsFromSkillOutput(inputPath) {
  const raw = await fs.readFile(inputPath, "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));

  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed.jobs)) {
    return parsed.jobs;
  }

  throw new Error(`Unsupported jobs payload in ${inputPath}`);
}

export async function loadSkillReport(inputPath) {
  const raw = await fs.readFile(inputPath, "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));

  if (Array.isArray(parsed)) {
    return { jobs: parsed };
  }

  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.jobs)) {
      return parsed;
    }
  }

  throw new Error(`Unsupported jobs payload in ${inputPath}`);
}

export async function writeCanonicalSkillReport(report, targetDir) {
  if (!report || !Array.isArray(report.jobs)) {
    throw new Error("Cannot write canonical skill report without a jobs array");
  }

  const outputDir = targetDir || (await resolveLatestSkillOutputDir());
  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, CANONICAL_FILE_NAME);
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  await fs.writeFile(outputPath, payload, "utf8");

  return outputPath;
}
