import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(dirname(__dirname), "memory.db");

interface MemoryRow {
  id: number;
  session_id: string;
  project_path: string | null;
  turn_index: number;
  user_message: string;
  assistant_message: string;
  created_at: string;
}

interface SearchResult extends MemoryRow {
  score: number;
}

async function getEmbedding(text: string): Promise<number[]> {
  const response = await fetch("http://localhost:11434/api/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "nomic-embed-text",
      input: text.slice(0, 8000),
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status}`);
  }

  const data = await response.json();
  return data.embeddings[0];
}

function rrfScore(rank: number, k: number = 60): number {
  return 1 / (k + rank);
}

function applyTimeDecay(score: number, createdAt: string, halfLifeDays: number = 30): number {
  const now = Date.now();
  const created = new Date(createdAt).getTime();
  const daysPassed = (now - created) / (1000 * 60 * 60 * 24);
  const decayFactor = Math.pow(0.5, daysPassed / halfLifeDays);
  return score * decayFactor;
}

async function hybridSearch(
  db: Database.Database,
  query: string,
  limit: number = 10
): Promise<SearchResult[]> {
  const results = new Map<number, SearchResult>();

  // 1. キーワード検索 (FTS5)
  try {
    const ftsResults = db
      .prepare(
        `
      SELECT m.*, bm25(memories_fts) as fts_score
      FROM memories_fts f
      JOIN memories m ON f.rowid = m.id
      WHERE memories_fts MATCH ?
      ORDER BY fts_score
      LIMIT ?
    `
      )
      .all(query, limit * 2) as (MemoryRow & { fts_score: number })[];

    ftsResults.forEach((row, index) => {
      const rrf = rrfScore(index + 1);
      results.set(row.id, {
        ...row,
        score: rrf,
      });
    });
  } catch (err) {
    // FTSクエリエラーは無視（特殊文字など）
    console.error("FTS search error:", err);
  }

  // 2. ベクトル検索
  try {
    const queryEmbedding = await getEmbedding(query);
    const float32 = new Float32Array(queryEmbedding);
    const embeddingBuffer = Buffer.from(float32.buffer);

    const vecResults = db
      .prepare(
        `
      SELECT m.*, v.distance
      FROM memories_vec v
      JOIN memories m ON v.memory_id = m.id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance
    `
      )
      .all(embeddingBuffer, limit * 2) as (MemoryRow & { distance: number })[];

    vecResults.forEach((row, index) => {
      const rrf = rrfScore(index + 1);
      const existing = results.get(row.id);
      if (existing) {
        existing.score += rrf;
      } else {
        results.set(row.id, {
          ...row,
          score: rrf,
        });
      }
    });
  } catch (err) {
    console.error("Vector search error:", err);
  }

  // 3. 時間減衰を適用してソート
  const sorted = Array.from(results.values())
    .map((r) => ({
      ...r,
      score: applyTimeDecay(r.score, r.created_at),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return sorted;
}

async function main() {
  const server = new McpServer({
    name: "claude-memory",
    version: "1.0.0",
  });

  // 検索ツール
  server.tool(
    "search_memory",
    "Search past conversation memories using hybrid keyword + semantic search",
    {
      query: z.string().describe("Search query"),
      limit: z.number().optional().default(10).describe("Maximum number of results"),
    },
    async ({ query, limit }) => {
      const db = new Database(DB_PATH);
      sqliteVec.load(db);

      try {
        const results = await hybridSearch(db, query, limit);

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No memories found matching your query.",
              },
            ],
          };
        }

        const formatted = results
          .map((r, i) => {
            const date = new Date(r.created_at).toLocaleDateString("ja-JP");
            const userTruncated = r.user_message.length > 500;
            const assistantTruncated = r.assistant_message.length > 500;
            return `## Result ${i + 1} (id: ${r.id}, score: ${r.score.toFixed(4)}, date: ${date})
**Project:** ${r.project_path || "unknown"}

**User:** ${r.user_message.slice(0, 500)}${userTruncated ? "... [truncated]" : ""}

**Assistant:** ${r.assistant_message.slice(0, 500)}${assistantTruncated ? "... [truncated]" : ""}
`;
          })
          .join("\n---\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} memories:\n\n${formatted}`,
            },
          ],
        };
      } finally {
        db.close();
      }
    }
  );

  // 統計ツール
  server.tool("memory_stats", "Get memory database statistics", {}, async () => {
    const db = new Database(DB_PATH);

    try {
      const stats = db
        .prepare(
          `
        SELECT
          COUNT(*) as total_memories,
          COUNT(DISTINCT session_id) as total_sessions,
          COUNT(DISTINCT project_path) as total_projects,
          MIN(created_at) as oldest,
          MAX(created_at) as newest
        FROM memories
      `
        )
        .get() as {
        total_memories: number;
        total_sessions: number;
        total_projects: number;
        oldest: string;
        newest: string;
      };

      return {
        content: [
          {
            type: "text",
            text: `Memory Statistics:
- Total memories: ${stats.total_memories}
- Total sessions: ${stats.total_sessions}
- Total projects: ${stats.total_projects}
- Oldest: ${stats.oldest || "N/A"}
- Newest: ${stats.newest || "N/A"}`,
          },
        ],
      };
    } finally {
      db.close();
    }
  });

  // 全文取得ツール
  server.tool(
    "get_memory",
    "Get full content of a specific memory by ID (use after search_memory to see truncated content)",
    {
      id: z.number().describe("Memory ID from search results"),
    },
    async ({ id }) => {
      const db = new Database(DB_PATH);

      try {
        const memory = db
          .prepare(
            `SELECT * FROM memories WHERE id = ?`
          )
          .get(id) as MemoryRow | undefined;

        if (!memory) {
          return {
            content: [
              {
                type: "text",
                text: `Memory with ID ${id} not found.`,
              },
            ],
          };
        }

        const date = new Date(memory.created_at).toLocaleDateString("ja-JP");
        return {
          content: [
            {
              type: "text",
              text: `## Memory ${memory.id} (date: ${date})
**Project:** ${memory.project_path || "unknown"}
**Session:** ${memory.session_id}
**Turn:** ${memory.turn_index}

### User Message
${memory.user_message || "(empty)"}

### Assistant Message
${memory.assistant_message || "(empty)"}`,
            },
          ],
        };
      } finally {
        db.close();
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
