import mongoose from "mongoose";

const jobSchema = new mongoose.Schema(
  {
    jobKey: { type: String, required: true, unique: true, index: true },
    title: String,
    company: String,
    job_family: String,
    first_posted_at: String,
    company_size: String,
    location: String,
    work_mode: String,
    employment_type: String,
    salary: String,
    japanese_level: String,
    english_level: String,
    visa_support: String,
    tech_stack: String,
    benefits: [String],
    education_requirements: String,
    experience_requirements: String,
    other_requirements: String,
    summary: String,
    url: String,
    source: String,
    source_url: String,
    source_date: String,
    hiring_status: String,
    status_reason: String,
    closedAt: String,
    isFavorite: { type: Boolean, default: false },
    favoritedAt: String,
    manuallyClosed: { type: Boolean, default: false },
    manualInvalidationRuleId: String,
    manualInvalidationMatchedFields: [String],
    match_score: Number,
    notes: String,
    version: { type: Number, default: 1 },
    firstSeenAt: String,
    lastSeenAt: String,
    lastImportBatch: String
  },
  { versionKey: false, timestamps: true }
);

const JobModel = mongoose.models.Job || mongoose.model("Job", jobSchema);

const manualInvalidationSchema = new mongoose.Schema(
  {
    ruleKey: { type: String, required: true, unique: true, index: true },
    jobKey: { type: String, required: true, index: true },
    matchedFields: [String],
    fieldSnapshot: mongoose.Schema.Types.Mixed,
    reason: String,
    evidenceText: String,
    createdAtManual: String,
    updatedAtManual: String
  },
  { versionKey: false }
);

const ManualInvalidationModel =
  mongoose.models.ManualInvalidation || mongoose.model("ManualInvalidation", manualInvalidationSchema);

export class MongoJobStore {
  constructor(uri) {
    this.uri = uri;
  }

  async init() {
    await mongoose.connect(this.uri);
  }

  async getAllJobs() {
    return JobModel.find({}).lean();
  }

  async getJobByKey(jobKey) {
    return JobModel.findOne({ jobKey }).lean();
  }

  async replaceAllJobs(jobs) {
    await JobModel.deleteMany({});
    if (jobs.length) {
      await JobModel.insertMany(jobs);
    }
    return jobs;
  }

  async updateJob(jobKey, patch) {
    const updated = await JobModel.findOneAndUpdate({ jobKey }, { $set: patch }, { new: true, lean: true });
    return updated;
  }

  async getManualInvalidations() {
    return ManualInvalidationModel.find({}).lean();
  }

  async upsertManualInvalidation(rule) {
    const now = new Date().toISOString();
    return ManualInvalidationModel.findOneAndUpdate(
      { ruleKey: rule.ruleKey },
      {
        $set: {
          ...rule,
          updatedAtManual: now,
          createdAtManual: rule.createdAtManual || now
        }
      },
      { upsert: true, new: true, lean: true }
    );
  }

  async deleteManualInvalidation(ruleKey) {
    if (!ruleKey) {
      return false;
    }

    const result = await ManualInvalidationModel.deleteOne({ ruleKey });
    return Boolean(result?.deletedCount);
  }
}
