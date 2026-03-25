import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync, readdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(dirname(__dirname), "memory.db");
const CLAUDE_DIR = join(process.env.HOME!, ".claude");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");

interface SessionInfo {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

interface Message {
  type: "user" | "assistant" | "file-history-snapshot";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
  };
  cwd?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
}

interface Turn {
  turnIndex: number;
  userMessage: string;
  assistantMessage: string;
}

async function getEmbedding(text: string): Promise<number[]> {
  const response = await fetch("http://localhost:11434/api/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "nomic-embed-text",
      input: text.slice(0, 8000), // トークン制限対策
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status}`);
  }

  const data = await response.json();
  return data.embeddings[0];
}

function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!)
    .join("\n");
}

function parseSessionLog(logPath: string): Turn[] {
  const content = readFileSync(logPath, "utf-8");
  const lines = content.trim().split("\n");
  const messages: Message[] = [];

  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as Message;
      if (msg.type === "user" || msg.type === "assistant") {
        messages.push(msg);
      }
    } catch {
      // JSONパースエラーは無視
    }
  }

  // ターンごとにペアリング
  const turns: Turn[] = [];
  let turnIndex = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.type === "user" && msg.message) {
      const userText = extractTextContent(msg.message.content);

      // 次のassistantメッセージを探す
      let assistantText = "";
      for (let j = i + 1; j < messages.length; j++) {
        const next = messages[j];
        if (next.type === "user") break;
        if (next.type === "assistant" && next.message) {
          assistantText += extractTextContent(next.message.content);
        }
      }

      if (userText.trim() || assistantText.trim()) {
        turns.push({
          turnIndex: turnIndex++,
          userMessage: userText.trim(),
          assistantMessage: assistantText.trim(),
        });
      }
    }
  }

  return turns;
}

function findProjectPath(sessionId: string): string | null {
  // sessionsディレクトリからプロジェクトパスを特定
  const sessionFiles = readdirSync(SESSIONS_DIR);
  for (const file of sessionFiles) {
    const filePath = join(SESSIONS_DIR, file);
    try {
      const session: SessionInfo = JSON.parse(readFileSync(filePath, "utf-8"));
      if (session.sessionId === sessionId) {
        return session.cwd;
      }
    } catch {
      // パースエラーは無視
    }
  }
  return null;
}

function findSessionLogPath(sessionId: string): string | null {
  // projectsディレクトリ内を検索
  const projectDirs = readdirSync(PROJECTS_DIR);
  for (const projectDir of projectDirs) {
    const projectPath = join(PROJECTS_DIR, projectDir);
    const logPath = join(projectPath, `${sessionId}.jsonl`);
    if (existsSync(logPath)) {
      return logPath;
    }
  }
  return null;
}

async function saveSession(sessionId: string): Promise<number> {
  const logPath = findSessionLogPath(sessionId);
  if (!logPath) {
    console.error(`Session log not found for: ${sessionId}`);
    return 0;
  }

  const projectPath = findProjectPath(sessionId);
  const turns = parseSessionLog(logPath);

  if (turns.length === 0) {
    console.log("No turns to save");
    return 0;
  }

  const db = new Database(DB_PATH);
  sqliteVec.load(db);

  const insertMemory = db.prepare(`
    INSERT INTO memories (session_id, project_path, turn_index, user_message, assistant_message)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertVec = db.prepare(`
    INSERT INTO memories_vec (memory_id, embedding)
    VALUES (?, ?)
  `);

  // 既存のセッションデータを確認
  const existing = db
    .prepare("SELECT MAX(turn_index) as max_turn FROM memories WHERE session_id = ?")
    .get(sessionId) as { max_turn: number | null };

  const startTurn = existing?.max_turn !== null ? existing.max_turn + 1 : 0;
  const newTurns = turns.filter((t) => t.turnIndex >= startTurn);

  console.log(`Saving ${newTurns.length} new turns (starting from turn ${startTurn})`);

  let saved = 0;
  for (const turn of newTurns) {
    try {
      // メモリ保存
      const result = insertMemory.run(
        sessionId,
        projectPath,
        turn.turnIndex,
        turn.userMessage,
        turn.assistantMessage
      );

      const memoryId = BigInt(result.lastInsertRowid);

      // 埋め込み生成・保存
      const combinedText = `Q: ${turn.userMessage}\nA: ${turn.assistantMessage}`;
      const embedding = await getEmbedding(combinedText);

      // Float32ArrayをBufferに変換
      const float32 = new Float32Array(embedding);
      const embeddingBuffer = Buffer.from(float32.buffer);
      insertVec.run(memoryId, embeddingBuffer);

      saved++;
      console.log(`Saved turn ${turn.turnIndex}`);
    } catch (err) {
      console.error(`Error saving turn ${turn.turnIndex}:`, err);
    }
  }

  db.close();
  console.log(`Total saved: ${saved} turns`);
  return saved;
}

async function getCurrentSessionId(): Promise<string | null> {
  // 環境変数から取得を試みる
  if (process.env.CLAUDE_SESSION_ID) {
    return process.env.CLAUDE_SESSION_ID;
  }

  // 最新のセッションファイルを探す
  const sessionFiles = readdirSync(SESSIONS_DIR);
  let latestSession: SessionInfo | null = null;
  let latestTime = 0;

  for (const file of sessionFiles) {
    const filePath = join(SESSIONS_DIR, file);
    try {
      const session: SessionInfo = JSON.parse(readFileSync(filePath, "utf-8"));
      if (session.startedAt > latestTime) {
        latestTime = session.startedAt;
        latestSession = session;
      }
    } catch {
      // パースエラーは無視
    }
  }

  return latestSession?.sessionId ?? null;
}

// メイン実行
async function main() {
  const sessionId = process.argv[2] || (await getCurrentSessionId());

  if (!sessionId) {
    console.error("No session ID provided or found");
    process.exit(1);
  }

  console.log(`Processing session: ${sessionId}`);
  await saveSession(sessionId);
}

main().catch(console.error);
