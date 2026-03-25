import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = `${dirname(__dirname)}/memory.db`;

export function initDatabase(): Database.Database {
  const db = new Database(DB_PATH);
  sqliteVec.load(db);

  // メインテーブル
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_path TEXT,
      turn_index INTEGER NOT NULL,
      user_message TEXT,
      assistant_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
  `);

  // FTS5 全文検索（trigramトークナイザ）
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      user_message,
      assistant_message,
      content='memories',
      content_rowid='id',
      tokenize='trigram'
    );

    -- トリガーでFTSを同期
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, user_message, assistant_message)
      VALUES (new.id, new.user_message, new.assistant_message);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, user_message, assistant_message)
      VALUES ('delete', old.id, old.user_message, old.assistant_message);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, user_message, assistant_message)
      VALUES ('delete', old.id, old.user_message, old.assistant_message);
      INSERT INTO memories_fts(rowid, user_message, assistant_message)
      VALUES (new.id, new.user_message, new.assistant_message);
    END;
  `);

  // ベクトルテーブル（sqlite-vec）768次元
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
      memory_id INTEGER,
      embedding FLOAT[768]
    );
  `);

  console.log("Database initialized at:", DB_PATH);
  return db;
}

// 直接実行時
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = initDatabase();
  db.close();
}
