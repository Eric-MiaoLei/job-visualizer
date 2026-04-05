import fs from "fs/promises";
import path from "path";
import { STORAGE_DIR } from "../config.js";

const FILE_PATH = path.join(STORAGE_DIR, "jobs.json");
const MANUAL_INVALIDATIONS_PATH = path.join(STORAGE_DIR, "manual-invalidations.json");

async function ensureStorage() {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  try {
    await fs.access(FILE_PATH);
  } catch {
    await fs.writeFile(FILE_PATH, "[]", "utf8");
  }
  try {
    await fs.access(MANUAL_INVALIDATIONS_PATH);
  } catch {
    await fs.writeFile(MANUAL_INVALIDATIONS_PATH, "[]", "utf8");
  }
}

export class FileJobStore {
  async init() {
    await ensureStorage();
  }

  async getAllJobs() {
    await ensureStorage();
    const raw = await fs.readFile(FILE_PATH, "utf8");
    return JSON.parse(raw);
  }

  async getJobByKey(jobKey) {
    const jobs = await this.getAllJobs();
    return jobs.find((job) => job.jobKey === jobKey) || null;
  }

  async replaceAllJobs(jobs) {
    await ensureStorage();
    await fs.writeFile(FILE_PATH, JSON.stringify(jobs, null, 2), "utf8");
    return jobs;
  }

  async updateJob(jobKey, patch) {
    const jobs = await this.getAllJobs();
    const index = jobs.findIndex((job) => job.jobKey === jobKey);
    if (index === -1) {
      return null;
    }

    jobs[index] = {
      ...jobs[index],
      ...patch
    };
    await this.replaceAllJobs(jobs);
    return jobs[index];
  }

  async getManualInvalidations() {
    await ensureStorage();
    const raw = await fs.readFile(MANUAL_INVALIDATIONS_PATH, "utf8");
    return JSON.parse(raw);
  }

  async upsertManualInvalidation(rule) {
    const rules = await this.getManualInvalidations();
    const index = rules.findIndex((item) => item.ruleKey === rule.ruleKey);
    const now = new Date().toISOString();
    const nextRule = {
      ...rule,
      updatedAtManual: now,
      createdAtManual: rule.createdAtManual || now
    };

    if (index === -1) {
      rules.push(nextRule);
    } else {
      rules[index] = {
        ...rules[index],
        ...nextRule
      };
    }

    await fs.writeFile(MANUAL_INVALIDATIONS_PATH, JSON.stringify(rules, null, 2), "utf8");
    return nextRule;
  }

  async deleteManualInvalidation(ruleKey) {
    const rules = await this.getManualInvalidations();
    const nextRules = rules.filter((item) => item.ruleKey !== ruleKey);
    const deleted = nextRules.length !== rules.length;
    if (deleted) {
      await fs.writeFile(MANUAL_INVALIDATIONS_PATH, JSON.stringify(nextRules, null, 2), "utf8");
    }
    return deleted;
  }
}
