-- EchoCast Database Schema (Cloudflare D1)
-- 用于记录生成任务元数据与付费墙转化线索

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, extracting, scripting, synthesizing, completed, failed
  source_type TEXT NOT NULL,              -- url | text
  source_input TEXT NOT NULL,
  title TEXT,
  original_author TEXT,
  source_url TEXT,
  script_json TEXT,                       -- JSON string of structured debate dialogue
  audio_key TEXT,                         -- Cloudflare R2 object key (e.g. audio/{job_id}.mp3)
  audio_url TEXT,                         -- Relative or absolute URL to fetch MP3
  duration_seconds INTEGER DEFAULT 90,
  error_message TEXT,
  created_at INTEGER NOT NULL,            -- Unix timestamp (ms)
  updated_at INTEGER NOT NULL             -- Unix timestamp (ms)
);

CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- 付费墙解锁线索表（MVP 转化留资 stub）
CREATE TABLE IF NOT EXISTS paywall_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  email TEXT NOT NULL,
  intent TEXT DEFAULT 'unlock_full_episode',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(job_id)
);

CREATE INDEX IF NOT EXISTS idx_paywall_job ON paywall_leads(job_id);
