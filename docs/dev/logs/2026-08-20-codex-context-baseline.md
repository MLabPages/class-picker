# Codex context baseline

日付: 2026-08-20

## 目的

Class Picker のルートに Codex の入口を置き、既存の単一 HTML 実装を再調査せずに作業を再開できる引き継ぎ文書を追加する。

## 確認したこと

- `README.txt` と `index.html` を確認した。
- 参加コード、QR/共有 URL、Firebase 接続、ローカルフォールバック、管理画面が一つの HTML に実装されている。
- 作業前の作業ツリーにコード変更はなかった。

## 変更

- ルート `AGENTS.md` を追加した。
- `docs/architecture.md`、`docs/decisions.md`、`docs/current-state.md` を追加した。
- この作業ログを追加した。
- `index.html` と Firebase 設定は変更していない。

## 検証

- 文書の配置を確認する。
- `git diff --check` を実行する。
