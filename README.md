# engram-mcp

Claude Codeの会話履歴をローカルでセマンティック検索できるMCPサーバー。

## Features

- **Hybrid Search**: FTS5（キーワード検索）+ sqlite-vec（ベクトル検索）のRRF融合
- **Local Embeddings**: Ollama (nomic-embed-text) によるローカル埋め込み生成
- **Time Decay**: 古い記憶は検索スコアが減衰
- **Auto Save**: セッション終了時に会話を自動保存（hooks連携）

## Requirements

- Node.js 20+
- [Ollama](https://ollama.ai/) with `nomic-embed-text` model

```bash
ollama pull nomic-embed-text
```

## Installation

```bash
git clone https://github.com/lowbridgee/engram-mcp.git ~/.claude/memory
cd ~/.claude/memory
npm install
npm run build
npm run init-db
```

## Configuration

### 1. MCP Server設定

`~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["~/.claude/memory/dist/mcp_server.js"]
    }
  }
}
```

### 2. Auto-save Hook設定

`~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/memory/dist/save_session.js"
          }
        ]
      }
    ]
  }
}
```

## Usage

### MCP Tools

Claude Code内で以下のツールが使用可能：

- **`search_memory`**: 過去の会話をハイブリッド検索（結果にはIDが付与され、500文字以上は`[truncated]`表示）
- **`get_memory`**: 指定したIDのメモリ全文を取得（truncatedされた内容を見たいときに使用）
- **`memory_stats`**: データベースの統計情報を表示

### Manual Save

特定のセッションを手動で保存：

```bash
npm run save -- <session_id>
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│  Claude Code    │────▶│   engram-mcp    │
│   (MCP Client)  │     │   (MCP Server)  │
└─────────────────┘     └────────┬────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
┌───────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   memories    │      │  memories_fts   │      │  memories_vec   │
│  (main table) │      │     (FTS5)      │      │  (sqlite-vec)   │
└───────────────┘      └─────────────────┘      └─────────────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │     Ollama      │
                                                │ nomic-embed-text│
                                                └─────────────────┘
```

## Database Schema

```sql
-- Main table
CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_path TEXT,
  turn_index INTEGER NOT NULL,
  user_message TEXT,
  assistant_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- FTS5 for keyword search (trigram tokenizer)
CREATE VIRTUAL TABLE memories_fts USING fts5(...);

-- sqlite-vec for semantic search (768-dim embeddings)
CREATE VIRTUAL TABLE memories_vec USING vec0(
  memory_id INTEGER,
  embedding FLOAT[768]
);
```

## License

MIT
